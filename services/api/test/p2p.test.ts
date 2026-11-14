import type { Hex } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { afterEach, describe, expect, it } from 'vitest';
import { ANVIL } from './support/anvil.js';
import { type TestApp, buildTestApp, signIn, signInVerified } from './support/app.js';
import { phoneKey } from './support/phone-key.js';

const SENDER_KEY = ANVIL.accounts.payer.privateKey;
const RECEIVER_KEY = generatePrivateKey();

let testApp: TestApp | undefined;
afterEach(async () => {
  await testApp?.app.close();
  testApp = undefined;
});

type Session = Awaited<ReturnType<typeof signIn>>;

async function setup(env: Record<string, string> = {}) {
  testApp = await buildTestApp({ env });
  const { app, chain } = testApp;
  const receiver = await signInVerified(app, RECEIVER_KEY);
  const sender = await signInVerified(app, SENDER_KEY);
  chain.balances.set(sender.address.toLowerCase(), 100_000_000n);

  const call = (method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, who: Session, payload?: object) =>
    app.inject({ method, url, headers: who.auth, ...(payload ? { payload } : {}) });

  /** Registers a phone (hardware key + push token) for a user. */
  async function phone(who: Session, fcmToken: string) {
    const key = phoneKey();
    const response = await call('POST', '/devices', who, { publicKey: key.publicKey, platform: 'android', fcmToken });
    expect(response.statusCode).toBe(201);
    return { ...key, id: response.json().id as string };
  }
  const request = async (amount = '5000000') => {
    const response = await call('POST', '/p2p/requests', receiver, { amount });
    expect(response.statusCode).toBe(201);
    return response.json() as { id: string; challenge: Hex; status: string };
  };
  const tap = (id: string, deviceId: string, signature: Hex) => call('POST', `/p2p/requests/${id}/tap`, receiver, { deviceId, signature });

  /** What the sender's app does to approve: fetch the transfer, sign it with the wallet, send it. */
  async function approve(id: string, who: Session = sender, key: Hex = SENDER_KEY, tamper?: (m: Record<string, string>) => void) {
    const response = await call('GET', `/p2p/requests/${id}/authorization`, who);
    // Not allowed to see it: send something anyway, to check approve refuses on its own.
    if (response.statusCode !== 200) return call('POST', `/p2p/requests/${id}/approve`, who, { signature: `0x${'11'.repeat(65)}` });
    const typed = response.json();
    if (tamper) tamper(typed.message);
    const signature = await privateKeyToAccount(key).signTypedData(typed);
    return call('POST', `/p2p/requests/${id}/approve`, who, { signature });
  }
  return { ...testApp, receiver, sender, call, phone, request, tap, approve };
}

describe('tap to pay', () => {
  it('identifies the sender by a tap, pushes only the request ID, then relays the approved transfer', async () => {
    const { call, phone, request, tap, approve, receiver, sender, push, chain, container } = await setup();
    await call('PUT', '/me/profile', receiver, { displayName: '  Somchai   Coffee ' });
    const senderPhone = await phone(sender, 'sender-fcm');
    await phone(receiver, 'receiver-fcm');

    const created = await request('5000000');
    expect(created).toMatchObject({ status: 'CREATED', role: 'receiver', amount: '5000000', recipient: { name: 'Somchai Coffee', verified: false } });
    expect(created.challenge).toMatch(/^0x[0-9a-f]{64}$/);

    // The receiver's phone read the sender's phone: device ID and a signature over the challenge.
    const tapped = await tap(created.id, senderPhone.id, senderPhone.signTap(created.challenge));
    expect(tapped.statusCode).toBe(200);
    expect(tapped.json()).toMatchObject({ status: 'SENDER_IDENTIFIED', sender: { address: sender.address } });
    expect(tapped.json().challenge).toBeUndefined();
    expect(push.sent).toEqual([
      { token: 'sender-fcm', message: { title: 'Payment request', body: 'Open GlobalPay to review it', data: { type: 'p2p_request', requestId: created.id } } },
    ]);

    // The sender sees it, with the recipient's name, and approves.
    const incoming = (await call('GET', '/p2p/incoming', sender)).json().requests;
    expect(incoming).toEqual([expect.objectContaining({ id: created.id, role: 'sender', recipient: expect.objectContaining({ name: 'Somchai Coffee' }) })]);
    const approved = await approve(created.id);
    expect(approved.statusCode).toBe(200);
    expect(approved.json()).toMatchObject({ status: 'SUBMITTED', transaction: { hash: expect.stringMatching(/^0x/) } });
    expect(chain.balances.get(receiver.address.toLowerCase())).toBe(5_000_000n);
    expect(chain.sent.at(-1)).toMatchObject({ functionName: 'transferWithAuthorization' });

    await container.workers.p2p.tick();
    expect((await call('GET', `/p2p/requests/${created.id}`, receiver)).json().status).toBe('COMPLETED');
    expect(push.sent.at(-1)).toMatchObject({ token: 'receiver-fcm', message: { data: { type: 'p2p_completed', requestId: created.id } } });
  });

  it('rejects a bad signature, a reused challenge and a revoked phone', async () => {
    const { phone, request, tap, call, sender } = await setup();
    const senderPhone = await phone(sender, 'fcm-1');
    const created = await request();

    expect((await tap(created.id, senderPhone.id, phoneKey().signTap(created.challenge))).json().error).toBe('invalid_tap');
    expect((await tap(created.id, 'device_nope', senderPhone.signTap(created.challenge))).json().error).toBe('invalid_tap');
    expect((await tap(created.id, senderPhone.id, senderPhone.signTap(created.challenge))).statusCode).toBe(200);
    const again = await tap(created.id, senderPhone.id, senderPhone.signTap(created.challenge));
    expect(again.statusCode).toBe(409);
    expect(again.json().error).toBe('request_unavailable');

    expect((await call('DELETE', `/devices/${senderPhone.id}`, sender)).statusCode).toBe(204);
    const next = await request();
    expect((await tap(next.id, senderPhone.id, senderPhone.signTap(next.challenge))).json().error).toBe('invalid_tap');
  });

  it('lets only the identified sender see the transfer, approve or decline', async () => {
    const { phone, request, tap, call, approve, sender, app } = await setup();
    const senderPhone = await phone(sender, 'fcm-1');
    const created = await request();
    await tap(created.id, senderPhone.id, senderPhone.signTap(created.challenge));

    const strangerKey = generatePrivateKey();
    const stranger = await signInVerified(app, strangerKey);
    expect((await call('GET', `/p2p/requests/${created.id}`, stranger)).statusCode).toBe(404);
    expect((await call('GET', `/p2p/requests/${created.id}/authorization`, stranger)).statusCode).toBe(404);
    expect((await approve(created.id, stranger, strangerKey)).statusCode).toBe(404);
    expect((await call('POST', `/p2p/requests/${created.id}/decline`, stranger)).statusCode).toBe(404);

    const declined = await call('POST', `/p2p/requests/${created.id}/decline`, sender);
    expect(declined.json().status).toBe('DECLINED');
  });

  it('refuses a signature over a changed amount or recipient, and one from another wallet', async () => {
    const { phone, request, tap, approve, sender } = await setup();
    const senderPhone = await phone(sender, 'fcm-1');
    const created = await request('5000000');
    await tap(created.id, senderPhone.id, senderPhone.signTap(created.challenge));

    const more = await approve(created.id, sender, SENDER_KEY, (m) => (m.value = '50000000'));
    expect(more.json().error).toBe('invalid_signature');
    const elsewhere = await approve(created.id, sender, SENDER_KEY, (m) => (m.to = ANVIL.accounts.treasury.address));
    expect(elsewhere.json().error).toBe('invalid_signature');
    expect((await approve(created.id, sender, generatePrivateKey())).json().error).toBe('invalid_signature');
    expect((await approve(created.id)).statusCode).toBe(200);
  });

  it('keeps the request when the transfer would fail, and expires it if nobody approves', async () => {
    const { phone, request, tap, approve, sender, chain, repos, call, container, receiver } = await setup();
    const senderPhone = await phone(sender, 'fcm-1');
    const created = await request('5000000');
    await tap(created.id, senderPhone.id, senderPhone.signTap(created.challenge));

    chain.balances.set(sender.address.toLowerCase(), 1n);
    const broke = await approve(created.id);
    expect(broke.statusCode).toBe(422);
    expect(broke.json().error).toBe('transaction_rejected');
    expect((await call('GET', `/p2p/requests/${created.id}`, sender)).json().status).toBe('SENDER_IDENTIFIED');

    repos.state.paymentRequests.get(created.id)!.expiresAt = new Date(Date.now() - 1_000);
    expect((await approve(created.id)).json().error).toBe('request_expired');
    await container.workers.p2p.tick();
    expect((await call('GET', `/p2p/requests/${created.id}`, receiver)).json().status).toBe('EXPIRED');
  });

  it('works by QR too: the sender claims with the challenge', async () => {
    const { request, call, sender, receiver, approve } = await setup();
    const created = await request();
    expect((await call('POST', `/p2p/requests/${created.id}/claim`, sender, { challenge: `0x${'00'.repeat(32)}` })).statusCode).toBe(404);
    expect((await call('POST', `/p2p/requests/${created.id}/claim`, receiver, { challenge: created.challenge })).json().error).toBe('cannot_pay_yourself');

    const claimed = await call('POST', `/p2p/requests/${created.id}/claim`, sender, { challenge: created.challenge });
    expect(claimed.json()).toMatchObject({ status: 'SENDER_IDENTIFIED', role: 'sender' });
    expect((await approve(created.id)).json().status).toBe('SUBMITTED');
  });

  it('limits open requests per receiver and waiting requests per sender', async () => {
    const { request, call, phone, tap, sender, app } = await setup({ P2P_MAX_OPEN_REQUESTS: '2', P2P_MAX_AWAITING_PER_SENDER: '1' });
    const first = await request();
    const second = await request();
    const third = await call('POST', '/p2p/requests', (await signInVerified(app, RECEIVER_KEY)), { amount: '1' });
    expect(third.statusCode).toBe(429);

    const receiverAgain = await signInVerified(app, RECEIVER_KEY);
    const senderPhone = await phone(sender, 'fcm-1');
    expect((await tap(first.id, senderPhone.id, senderPhone.signTap(first.challenge))).statusCode).toBe(200);
    await call('POST', `/p2p/requests/${second.id}/cancel`, receiverAgain);

    // The sender already has one request waiting for them: another tap is refused...
    const fourth = await request();
    expect((await tap(fourth.id, senderPhone.id, senderPhone.signTap(fourth.challenge))).statusCode).toBe(429);
    // ...until that one is out of the way.
    await call('POST', `/p2p/requests/${first.id}/cancel`, receiverAgain);
    expect((await tap(fourth.id, senderPhone.id, senderPhone.signTap(fourth.challenge))).statusCode).toBe(200);
  });

  it('checks amounts, names, keys and verification', async () => {
    const { call, receiver, sender, app } = await setup({ P2P_MAX_AMOUNT_USDC: '100' });
    expect((await call('POST', '/p2p/requests', receiver, { amount: '0' })).json().error).toBe('invalid_amount');
    expect((await call('POST', '/p2p/requests', receiver, { amount: '100000001' })).json().error).toBe('amount_too_large');
    expect((await call('PUT', '/me/profile', receiver, { displayName: 'x' })).json().error).toBe('invalid_name');
    expect((await call('PUT', '/me/profile', receiver, { displayName: '<script>' })).json().error).toBe('invalid_name');

    expect((await call('POST', '/devices', receiver, { publicKey: phoneKey('secp256k1').publicKey, platform: 'android' })).json().error).toBe(
      'invalid_device_key',
    );
    const key = phoneKey().publicKey;
    expect((await call('POST', '/devices', receiver, { publicKey: key, platform: 'android' })).statusCode).toBe(201);
    expect((await call('POST', '/devices', sender, { publicKey: key, platform: 'android' })).json().error).toBe('device_taken');

    const unverified = await signIn(app, generatePrivateKey());
    expect((await call('POST', '/p2p/requests', unverified, { amount: '1' })).statusCode).toBe(403);
  });

  it('forgets a push token FCM no longer knows', async () => {
    const { phone, request, tap, sender, push, repos } = await setup();
    const senderPhone = await phone(sender, 'stale-token');
    push.unregistered.add('stale-token');
    const created = await request();
    await tap(created.id, senderPhone.id, senderPhone.signTap(created.challenge));
    expect(repos.state.devices.get(senderPhone.id)?.fcmToken).toBeUndefined();
  });
});
