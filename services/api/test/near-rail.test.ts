import { createPublicKey, verify as verifyNode } from 'node:crypto';
import { KeyPairSigner, baseDecode } from 'near-api-js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { publicKeyOfImplicitAccount } from '../src/adapters/near/keys.js';
import { buildPromptPayQr } from '../src/lib/promptpay/build.js';
import { ANVIL } from './support/anvil.js';
import { type TestApp, buildTestApp } from './support/app.js';
import { FakeNearGateway, RecordingOnboarding } from './support/fake-near.js';
import { NEAR, type NearPaymentJson, implicitAccount, nearEnv, nearSignIn, nearTestKey, signNearPayment } from './support/near.js';

const qr = buildPromptPayQr({
  kind: 'merchant',
  targetType: 'biller',
  targetId: '099999999999901',
  amount: { currency: 'THB', minor: 100_00n },
});
const PAYER = implicitAccount(NEAR.payerKey);
const PAYER_PUBLIC_KEY = NEAR.payerKey.getPublicKey().toString();

// The first test warms up ed25519 and the app; with every test file running in parallel that can pass 5 s.
vi.setConfig({ testTimeout: 30_000 });

let testApp: TestApp | undefined;

afterEach(async () => {
  await testApp?.app.close();
  testApp = undefined;
});

async function setup(env: Record<string, string> = {}) {
  const near = new FakeNearGateway();
  near.setAccessKey(PAYER, PAYER_PUBLIC_KEY, 41n);
  const onboarding = new RecordingOnboarding();
  testApp = await buildTestApp({
    env: nearEnv({ PAYOUT_DELAY_MS: '0', PAYOUT_FAILURE_RATE: '0', ...env }),
    adapters: { nearGateway: near, nearOnboarding: onboarding },
  });
  const { app, container, repos } = testApp;
  const session = await nearSignIn(app);
  await app.inject({ method: 'POST', url: '/kyc/start', headers: session.auth });
  await app.inject({ method: 'GET', url: '/kyc/status', headers: session.auth });

  async function quote() {
    const response = await app.inject({ method: 'POST', url: '/quotes', headers: session.auth, payload: { payer: PAYER, qrPayload: qr } });
    if (response.statusCode !== 201) throw new Error(`quote failed: ${response.body}`);
    return response.json<{ quote: { quoteId: string; tokenAmount: string; payer: string; token: string }; signature: string; nearPayment: NearPaymentJson; authorizationToSign?: unknown }>();
  }
  async function pay() {
    const q = await quote();
    const signedDelegate = await signNearPayment(NEAR.payerKey, q.nearPayment);
    const response = await app.inject({ method: 'POST', url: '/payments', headers: session.auth, payload: { quoteId: q.quote.quoteId, signedDelegate } });
    return { quote: q, response };
  }
  const status = (id: string) => repos.state.payments.get(id)?.status;
  return { app, container, repos, near, onboarding, session, quote, pay, status };
}

describe('NEAR rail: sign-in (NEP-413)', () => {
  it('signs in an implicit account and starts testnet onboarding', async () => {
    const { app, onboarding, session } = await setup();
    expect(session.address).toBe(PAYER);
    expect(onboarding.accounts).toEqual([PAYER]);
    const me = await app.inject({ method: 'GET', url: '/me/balance', headers: session.auth });
    expect(me.json()).toEqual({ token: NEAR.usdc, units: '0', decimals: 6 });
  });

  it('gives a 32-byte nonce and a readable message naming the domain and nonce', async () => {
    const { app } = await setup();
    const response = await app.inject({ method: 'POST', url: '/auth/nonce', payload: { address: PAYER } });
    const { nonce, message } = response.json<{ nonce: string; message: string }>();
    expect(nonce).toMatch(/^[0-9a-f]{64}$/);
    expect(message).toContain('globalpay.local');
    expect(message).toContain(nonce);
    expect(message).toContain(PAYER);
  });

  it('refuses an EVM address', async () => {
    const { app } = await setup();
    const response = await app.inject({ method: 'POST', url: '/auth/nonce', payload: { address: ANVIL.accounts.payer.address } });
    expect(response.statusCode).toBe(400);
  });

  async function signed(key = NEAR.payerKey, account = PAYER) {
    const { app } = testApp!;
    const { message, nonce } = (await app.inject({ method: 'POST', url: '/auth/nonce', payload: { address: account } })).json();
    const sign = (text: string, recipient = 'globalpay.local') =>
      new KeyPairSigner(key).signNep413Message(account, { message: text, recipient, nonce: Buffer.from(nonce, 'hex') });
    return { message: message as string, sign };
  }
  const verify = (payload: object) => testApp!.app.inject({ method: 'POST', url: '/auth/verify', payload });
  const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64');

  it("refuses another key's signature for the account", async () => {
    await setup();
    const stranger = nearTestKey('stranger');
    const { message, sign } = await signed(stranger);
    const response = await verify({ message, signature: b64((await sign(message)).signature), publicKey: stranger.getPublicKey().toString() });
    expect(response.statusCode).toBe(401);
    expect(response.json().error).toBe('invalid_signature');
  });

  it('refuses a signature for another recipient, a changed message, or no public key', async () => {
    await setup();
    const { message, sign } = await signed();
    const otherApp = await verify({ message, signature: b64((await sign(message, 'evil.example')).signature), publicKey: PAYER_PUBLIC_KEY });
    expect(otherApp.json().error).toBe('invalid_signature');

    const changed = message.replace('globalpay.local', 'evil.example');
    const tampered = await verify({ message: changed, signature: b64((await sign(changed)).signature), publicKey: PAYER_PUBLIC_KEY });
    expect(tampered.json().error).toBe('invalid_siwe_message');

    const noKey = await verify({ message, signature: b64((await sign(message)).signature) });
    expect(noKey.statusCode).toBe(400);
  });

  it('uses a nonce once', async () => {
    await setup();
    const { message, sign } = await signed();
    const payload = { message, signature: b64((await sign(message)).signature), publicKey: PAYER_PUBLIC_KEY };
    expect((await verify(payload)).statusCode).toBe(200);
    expect((await verify(payload)).json().error).toBe('invalid_nonce');
  });
});

describe('NEAR rail: quotes', () => {
  it('returns nearPayment, with no authorizationToSign', async () => {
    const { quote, near } = await setup();
    const q = await quote();
    expect(q.authorizationToSign).toBeUndefined();
    expect(q.quote).toMatchObject({ payer: PAYER, token: NEAR.usdc });
    expect(q.nearPayment).toMatchObject({
      signerId: PAYER,
      publicKey: PAYER_PUBLIC_KEY,
      receiverId: NEAR.usdc,
      methodName: 'ft_transfer_call',
      gas: '100000000000000',
      deposit: '1',
      nonce: '42',
      maxBlockHeight: (near.finalHeight + 300n).toString(),
      args: { receiver_id: NEAR.settlement, amount: q.quote.tokenAmount },
    });
  });

  it('signs the quote JSON the contract checks, with the quote signer key', async () => {
    const { quote } = await setup();
    const q = await quote();
    const msg = JSON.parse(q.nearPayment.args.msg) as { quote: string; signature: string };
    expect(msg.signature).toBe(q.signature);
    const fields = JSON.parse(msg.quote);
    expect(Object.keys(fields)).toEqual([
      'quote_id', 'payer', 'token', 'token_amount', 'fiat_currency', 'fiat_amount', 'merchant_ref_hash', 'expires_at_ms',
    ]);
    expect(fields).toMatchObject({ quote_id: q.quote.quoteId, payer: PAYER, token: NEAR.usdc, token_amount: q.quote.tokenAmount, fiat_currency: 'THB', fiat_amount: '10000' });
    expect(typeof fields.expires_at_ms).toBe('number');

    const raw = baseDecode(NEAR.quoteSignerKey.getPublicKey().toString().slice('ed25519:'.length));
    const key = createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), raw]), format: 'der', type: 'spki' });
    expect(verifyNode(null, Buffer.from(msg.quote, 'utf8'), key, Buffer.from(msg.signature, 'base64'))).toBe(true);
  });

  it("refuses a quote until the account exists on-chain", async () => {
    const { app, near, session } = await setup();
    near.accessKeys.clear();
    const response = await app.inject({ method: 'POST', url: '/quotes', headers: session.auth, payload: { payer: PAYER, qrPayload: qr } });
    expect(response.statusCode).toBe(422);
    expect(response.json().error).toBe('near_account_not_found');
  });

  it('refuses an EVM payer', async () => {
    const { app, session } = await setup();
    const response = await app.inject({
      method: 'POST', url: '/quotes', headers: session.auth, payload: { payer: ANVIL.accounts.payer.address, qrPayload: qr },
    });
    expect(response.statusCode).toBe(400);
  });
});

describe('NEAR rail: payments', () => {
  it('relays the signed delegate and links nearblocks', async () => {
    const { pay, near } = await setup();
    const { response, quote } = await pay();
    expect(response.statusCode).toBe(202);
    const payment = response.json();
    const [sent] = near.sent;
    expect(sent).toMatchObject({ kind: 'delegate', quoteId: quote.quote.quoteId, receiverId: PAYER });
    expect(payment).toMatchObject({ status: 'SUBMITTED', token: NEAR.usdc });
    // base58 hashes are case-sensitive: stored and shown as sent.
    expect(payment.transactions.pay).toEqual({ hash: sent?.hash, url: `https://testnet.nearblocks.io/txns/${sent?.hash}` });
  });

  it('goes PAID, then SETTLED through the settlement contract', async () => {
    const { pay, container, near, status } = await setup();
    const { response } = await pay();
    const { id } = response.json();
    near.rememberHashes = false; // the event carries no hash: the one stored at submit stays

    await container.workers.indexer.tick();
    expect(status(id)).toBe('PAID');
    for (let i = 0; i < 4 && status(id) !== 'SETTLED'; i++) await container.workers.payouts.tick();
    expect(status(id)).toBe('SETTLED');
    expect(near.sent.map((s) => s.kind)).toEqual(['delegate', 'settle']);
    expect(await near.getPaymentStatus(response.json().quoteId)).toBe('Settled');
    expect(testApp!.repos.state.payments.get(id)?.payTxHash).toBe(near.sent[0]?.hash);
  });

  it('refunds when the payout fails', async () => {
    const { pay, container, near, status } = await setup({ PAYOUT_FAILURE_RATE: '1' });
    const { id } = (await pay()).response.json();
    await container.workers.indexer.tick();
    for (let i = 0; i < 4 && status(id) !== 'REFUNDED'; i++) await container.workers.payouts.tick();
    expect(status(id)).toBe('REFUNDED');
    expect(near.sent.map((s) => s.kind)).toEqual(['delegate', 'refund']);
  });

  it('refuses a delegate for another amount, and EVM fields', async () => {
    const { app, quote, session, near } = await setup();
    const q = await quote();
    const wrong = await signNearPayment(NEAR.payerKey, q.nearPayment, {
      args: { receiver_id: NEAR.settlement, amount: '1', msg: q.nearPayment.args.msg },
    });
    const response = await app.inject({ method: 'POST', url: '/payments', headers: session.auth, payload: { quoteId: q.quote.quoteId, signedDelegate: wrong } });
    expect(response.statusCode).toBe(422);
    expect(response.json().error).toBe('invalid_authorization');

    const evm = await app.inject({
      method: 'POST', url: '/payments', headers: session.auth, payload: { quoteId: q.quote.quoteId, validAfter: '0', validBefore: '1', signature: '0x12' },
    });
    expect(evm.statusCode).toBe(422);
    const neither = await app.inject({ method: 'POST', url: '/payments', headers: session.auth, payload: { quoteId: q.quote.quoteId } });
    expect(neither.statusCode).toBe(400);
    expect(near.sent).toEqual([]);
  });

  it('turns off tap to pay and Add money', async () => {
    const { app, session } = await setup();
    const p2p = await app.inject({ method: 'GET', url: '/p2p/requests/x', headers: session.auth });
    expect(p2p.statusCode).toBe(503);
    expect(p2p.json().error).toBe('not_configured');
    const onramp = await app.inject({ method: 'POST', url: '/onramp/orders', headers: session.auth, payload: { fiatAmountMinor: '100000' } });
    expect(onramp.statusCode).toBe(503);
  });
});

describe('NEAR rail: settings', () => {
  it('derives the public key of an implicit account', () => {
    expect(publicKeyOfImplicitAccount(PAYER)).toBe(PAYER_PUBLIC_KEY);
  });
});
