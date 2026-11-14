import { randomBytes } from 'node:crypto';
import { decodeJwt } from 'jose';
import { type KeyPair, KeyPairSigner, type Action, baseEncode } from 'near-api-js';
import type { Hex } from 'viem';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { type NearRelayerClient, NearTestnetFaucet } from '../src/adapters/near/faucet.js';
import { AuthService } from '../src/modules/auth/service.js';
import { AccessTokens } from '../src/modules/auth/tokens.js';
import type { NearOnboarding } from '../src/ports/near-chain.js';
import type { TxReceipt } from '../src/ports/settlement-gateway.js';
import { type TestApp, buildTestApp } from './support/app.js';
import { FakeNearGateway, RecordingOnboarding } from './support/fake-near.js';
import { createMemoryRepositories } from './support/memory-repositories.js';
import { NEAR, implicitAccount, nearEnv, nearTestKey } from './support/near.js';

// ed25519 warm-up plus every test file running in parallel can pass 5 s.
vi.setConfig({ testTimeout: 30_000 });

const DOMAIN = 'globalpay.local';
const PAYER = implicitAccount(NEAR.payerKey);
const PAYER_PUBLIC_KEY = NEAR.payerKey.getPublicKey().toString();
const STRANGER_KEY = nearTestKey('edge-stranger');
const STRANGER = implicitAccount(STRANGER_KEY);
const STRANGER_PUBLIC_KEY = STRANGER_KEY.getPublicKey().toString();
const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64');

async function signNep413(key: KeyPair, account: string, message: string, nonceHex: string, recipient = DOMAIN, callbackUrl?: string) {
  const signed = await new KeyPairSigner(key).signNep413Message(account, {
    message,
    recipient,
    nonce: Buffer.from(nonceHex, 'hex'),
    ...(callbackUrl === undefined ? {} : { callbackUrl }),
  });
  return b64(signed.signature);
}

let testApp: TestApp | undefined;
afterEach(async () => {
  await testApp?.app.close();
  testApp = undefined;
});

async function setup(options: { env?: Record<string, string>; onboarding?: NearOnboarding } = {}) {
  const onboarding = options.onboarding ?? new RecordingOnboarding();
  testApp = await buildTestApp({
    env: nearEnv(options.env),
    adapters: { nearGateway: new FakeNearGateway(), nearOnboarding: onboarding },
  });
  const { app } = testApp;
  const nonce = async (address: string = PAYER, remoteAddress?: string) => {
    const response = await app.inject({ method: 'POST', url: '/auth/nonce', payload: { address }, ...(remoteAddress ? { remoteAddress } : {}) });
    expect(response.statusCode).toBe(200);
    return response.json<{ nonce: string; message: string; expiresAt: string }>();
  };
  const verify = (payload: object, remoteAddress?: string) =>
    app.inject({ method: 'POST', url: '/auth/verify', payload, ...(remoteAddress ? { remoteAddress } : {}) });
  /** A correctly signed sign-in for `key`'s implicit account. */
  const signedIn = async (key: KeyPair = NEAR.payerKey) => {
    const account = implicitAccount(key);
    const { message, nonce: nonceHex } = await nonce(account);
    return { message, nonce: nonceHex, signature: await signNep413(key, account, message, nonceHex), publicKey: key.getPublicKey().toString() };
  };
  return { app, onboarding, nonce, verify, signedIn };
}

function expectRefused(response: { statusCode: number; json(): { error?: string } }, status: number, error: string) {
  expect(response.statusCode).toBe(status);
  expect(response.json().error).toBe(error);
}

describe('NEAR sign-in edge cases: nonces', () => {
  it('refuses a nonce the server never issued, even when correctly signed', async () => {
    const { nonce, verify } = await setup();
    const { message, nonce: issued } = await nonce();
    const forged = randomBytes(32).toString('hex');
    const changed = message.replace(issued, forged);
    expectRefused(await verify({ message: changed, signature: await signNep413(NEAR.payerKey, PAYER, changed, forged), publicKey: PAYER_PUBLIC_KEY }), 401, 'invalid_nonce');
  });

  it("refuses one account's nonce for another account, and leaves it usable by its owner", async () => {
    const { nonce, verify } = await setup();
    const { message, nonce: payerNonce } = await nonce(PAYER);
    const hijacked = message.replace(PAYER, STRANGER);
    const stolen = await verify({ message: hijacked, signature: await signNep413(STRANGER_KEY, STRANGER, hijacked, payerNonce), publicKey: STRANGER_PUBLIC_KEY });
    expectRefused(stolen, 401, 'invalid_nonce');

    const owner = await verify({ message, signature: await signNep413(NEAR.payerKey, PAYER, message, payerNonce), publicKey: PAYER_PUBLIC_KEY });
    expect(owner.statusCode).toBe(200);
  });

  it('does not burn the nonce on a bad signature', async () => {
    const { verify, signedIn } = await setup();
    const signed = await signedIn();
    const wrong = await signNep413(STRANGER_KEY, PAYER, signed.message, signed.nonce);
    expectRefused(await verify({ ...signed, signature: wrong }), 401, 'invalid_signature');
    expect((await verify(signed)).statusCode).toBe(200);
  });

  it('accepts exactly one of two concurrent sign-ins with the same signed nonce', async () => {
    const { verify, signedIn } = await setup();
    const signed = await signedIn();
    const responses = await Promise.all([verify(signed), verify(signed)]);
    expect(responses.map((r) => r.statusCode).sort()).toEqual([200, 401]);
    expect(responses.find((r) => r.statusCode === 401)?.json().error).toBe('invalid_nonce');
  });

  it('keeps every outstanding nonce usable until it is used or expires', async () => {
    const { verify, signedIn } = await setup();
    const first = await signedIn();
    const second = await signedIn();
    expect(second.nonce).not.toBe(first.nonce);
    expect((await verify(second)).statusCode).toBe(200);
    expect((await verify(first)).statusCode).toBe(200);
  });

  it.each([
    ['upper-case hex', () => PAYER.toUpperCase()],
    ['63 hex characters', () => PAYER.slice(1)],
    ['65 hex characters', () => `${PAYER}a`],
    ['a named account', () => 'alice.testnet'],
    ['a 0x-prefixed key', () => `0x${PAYER}`],
    ['an empty address', () => ''],
    ['an over-long address', () => 'a'.repeat(129)],
  ])('refuses a nonce for %s', async (_name, address) => {
    const { app } = await setup();
    const response = await app.inject({ method: 'POST', url: '/auth/nonce', payload: { address: address() } });
    expectRefused(response, 400, 'invalid_request');
  });
});

describe('NEAR sign-in edge cases: keys and signatures', () => {
  it("refuses another key's signature sent with the account's own public key", async () => {
    const { verify, signedIn } = await setup();
    const signed = await signedIn();
    const forged = await signNep413(STRANGER_KEY, PAYER, signed.message, signed.nonce);
    expectRefused(await verify({ ...signed, signature: forged }), 401, 'invalid_signature');
  });

  it("refuses the account's valid signature sent with a public key that isn't the account", async () => {
    const { verify, signedIn } = await setup();
    const signed = await signedIn();
    expectRefused(await verify({ ...signed, publicKey: STRANGER_PUBLIC_KEY }), 401, 'invalid_signature');
  });

  it('refuses a signature that adds a NEP-413 callback URL', async () => {
    const { verify, signedIn } = await setup();
    const signed = await signedIn();
    const withCallback = await signNep413(NEAR.payerKey, PAYER, signed.message, signed.nonce, DOMAIN, 'https://evil.example/cb');
    expectRefused(await verify({ ...signed, signature: withCallback }), 401, 'invalid_signature');
  });

  it('refuses a signature over the message with a different nonce', async () => {
    const { verify, signedIn } = await setup();
    const signed = await signedIn();
    const otherNonce = await signNep413(NEAR.payerKey, PAYER, signed.message, randomBytes(32).toString('hex'));
    expectRefused(await verify({ ...signed, signature: otherNonce }), 401, 'invalid_signature');
  });

  it.each([
    ['URL-safe base64', (s: string) => s.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '') + '-A'],
    ['missing padding', (s: string) => s.replace(/=+$/, '')],
    ['surrounding whitespace', (s: string) => ` ${s} `],
    ['63 bytes', (s: string) => b64(Buffer.from(s, 'base64').subarray(0, 63))],
    ['65 bytes', (s: string) => b64(Buffer.concat([Buffer.from(s, 'base64'), Buffer.of(0)]))],
    ['hex', (s: string) => Buffer.from(s, 'base64').toString('hex')],
    ['0x hex', (s: string) => `0x${Buffer.from(s, 'base64').toString('hex')}`],
    ['non-canonical padding bits', (s: string) => {
      const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
      const last = s.length - 3;
      return s.slice(0, last) + alphabet[alphabet.indexOf(s[last]!) | 1] + '==';
    }],
  ])('refuses a signature encoded as %s', async (_name, encode) => {
    const { verify, signedIn } = await setup();
    const signed = await signedIn();
    expectRefused(await verify({ ...signed, signature: encode(signed.signature) }), 401, 'invalid_signature');
    // The well-formed signature still works afterwards: the nonce wasn't spent.
    expect((await verify(signed)).statusCode).toBe(200);
  });

  it('validates the signature length at the schema', async () => {
    const { verify, signedIn } = await setup();
    const signed = await signedIn();
    expectRefused(await verify({ ...signed, signature: '' }), 400, 'invalid_request');
    expectRefused(await verify({ ...signed, signature: 'A'.repeat(1_004) }), 400, 'invalid_request');
  });

  it.each([
    ['a secp256k1 key', () => PAYER_PUBLIC_KEY.replace('ed25519:', 'secp256k1:')],
    ['an upper-case prefix', () => PAYER_PUBLIC_KEY.replace('ed25519:', 'ED25519:')],
    ['no prefix', () => PAYER_PUBLIC_KEY.slice('ed25519:'.length)],
    ['a non-base58 character', () => `ed25519:${'0'.repeat(44)}`],
    ['a 33-byte key', () => `ed25519:${baseEncode(Buffer.alloc(33, 0xff))}`],
    ['the implicit account in hex', () => PAYER],
  ])('refuses a public key with %s as a bad request', async (_name, publicKey) => {
    const { verify, signedIn } = await setup();
    const signed = await signedIn();
    expectRefused(await verify({ ...signed, publicKey: publicKey() }), 400, 'invalid_request');
  });

  it('refuses a well-formed public key of the wrong length (31 bytes) as a bad signature', async () => {
    const { verify, signedIn } = await setup();
    const signed = await signedIn();
    const short = `ed25519:${baseEncode(Buffer.alloc(31, 0x11))}`;
    expectRefused(await verify({ ...signed, publicKey: short }), 401, 'invalid_signature');
  });
});

describe('NEAR sign-in edge cases: the message', () => {
  it.each([
    ['Issued At', (m: string) => m.replace(/Issued At: \S+/, 'Issued At: 2020-01-01T00:00:00.000Z')],
    ['Expiration Time', (m: string) => m.replace(/Expiration Time: \S+/, 'Expiration Time: 2099-01-01T00:00:00.000Z')],
    ['the nonce', (m: string) => m.replace(/Nonce: [0-9a-f]{64}/, `Nonce: ${'0'.repeat(64)}`)],
  ])('refuses a message whose %s changed after signing', async (_name, tamper) => {
    const { verify, signedIn } = await setup();
    const signed = await signedIn();
    const changed = tamper(signed.message);
    expect(changed).not.toBe(signed.message);
    expectRefused(await verify({ ...signed, message: changed }), 401, 'invalid_signature');
  });

  it.each([
    ['a trailing newline', (m: string) => `${m}\n`],
    ['CRLF line endings', (m: string) => m.replace(/\n/g, '\r\n')],
    ['an upper-case domain', (m: string) => m.replace(DOMAIN, DOMAIN.toUpperCase())],
    ['a domain with a port', (m: string) => m.replace(DOMAIN, `${DOMAIN}:3000`)],
    ['an upper-case account', (m: string) => m.replace(PAYER, PAYER.toUpperCase())],
    ['an expiry that is not a date', (m: string) => m.replace(/Expiration Time: \S+/, 'Expiration Time: never')],
    ['a past expiry', (m: string) => m.replace(/Expiration Time: \S+/, 'Expiration Time: 2020-01-01T00:00:00.000Z')],
    ['the EVM wording', (m: string) => m.replace('with your NEAR account', 'with your Ethereum account')],
    ['an extra line', (m: string) => `${m}\nResources: https://evil.example`],
  ])('refuses a re-signed message with %s', async (_name, change) => {
    const { verify, signedIn } = await setup();
    const signed = await signedIn();
    const changed = change(signed.message);
    expect(changed).not.toBe(signed.message);
    const signature = await signNep413(NEAR.payerKey, PAYER, changed, signed.nonce);
    expectRefused(await verify({ ...signed, message: changed, signature }), 401, 'invalid_siwe_message');
    // The refusal didn't spend the nonce.
    expect((await verify(signed)).statusCode).toBe(200);
  });

  it('refuses a message over 2,000 characters at the schema', async () => {
    const { verify, signedIn } = await setup();
    const signed = await signedIn();
    expectRefused(await verify({ ...signed, message: `${signed.message}${' '.repeat(2_000)}` }), 400, 'invalid_request');
  });

  it('refuses a SIWE message on the NEAR rail', async () => {
    const { verify, signedIn } = await setup();
    const signed = await signedIn();
    const siwe = `${DOMAIN} wants you to sign in with your Ethereum account:\n0x${'1'.repeat(40)}\n\nURI: https://${DOMAIN}\nVersion: 1\nChain ID: 1\nNonce: ${signed.nonce}\nIssued At: 2026-11-14T00:00:00.000Z`;
    expectRefused(await verify({ ...signed, message: siwe }), 401, 'invalid_siwe_message');
  });
});

describe('NEAR sign-in edge cases: the access token', () => {
  it('names the user and implicit account, and lasts JWT_TTL_SECONDS', async () => {
    const { verify, signedIn } = await setup({ env: { JWT_TTL_SECONDS: '900' } });
    const signed = await signedIn();
    const before = Date.now();
    const response = await verify(signed);
    const after = Date.now();
    expect(response.statusCode).toBe(200);
    const body = response.json<{ token: string; tokenType: string; expiresAt: string; user: { id: string; walletAddress: string } }>();
    expect(body.tokenType).toBe('Bearer');
    expect(body.user.walletAddress).toBe(PAYER);
    const claims = decodeJwt(body.token);
    expect(claims).toMatchObject({ sub: body.user.id, wallet: PAYER, iss: 'globalpay-api', aud: 'globalpay-app' });
    expect(claims.exp! - claims.iat!).toBe(900);
    // Issued-at is whole seconds, so expiry is 900 s after the request, give or take that rounding.
    const expiresAt = new Date(body.expiresAt).getTime();
    expect(expiresAt).toBe(claims.exp! * 1000);
    expect(expiresAt).toBeGreaterThan(before + 899_000 - 1);
    expect(expiresAt).toBeLessThanOrEqual(after + 900_000);
  });

  it('gives two accounts two users, and one account the same user each time', async () => {
    const { verify, signedIn } = await setup();
    const a = (await verify(await signedIn())).json<{ user: { id: string } }>();
    const b = (await verify(await signedIn(STRANGER_KEY))).json<{ user: { id: string; walletAddress: string } }>();
    const again = (await verify(await signedIn())).json<{ user: { id: string } }>();
    expect(b.user.walletAddress).toBe(STRANGER);
    expect(b.user.id).not.toBe(a.user.id);
    expect(again.user.id).toBe(a.user.id);
  });

  it('refuses a stale bearer token even on the sign-in routes (the app must drop it to sign in again)', async () => {
    const { app } = await setup();
    const stale = { authorization: 'Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ4In0.c2lnbmF0dXJl' };
    const response = await app.inject({ method: 'POST', url: '/auth/nonce', headers: stale, payload: { address: PAYER } });
    expectRefused(response, 401, 'invalid_token');
    const fresh = await app.inject({ method: 'POST', url: '/auth/nonce', payload: { address: PAYER } });
    expect(fresh.statusCode).toBe(200);
  });
});

describe('NEAR sign-in edge cases: testnet onboarding', () => {
  it('never reaches onboarding for a refused sign-in', async () => {
    const { verify, signedIn, onboarding } = await setup();
    const signed = await signedIn();
    await verify({ ...signed, publicKey: STRANGER_PUBLIC_KEY });
    await verify({ ...signed, signature: await signNep413(STRANGER_KEY, PAYER, signed.message, signed.nonce) });
    expect((onboarding as RecordingOnboarding).accounts).toEqual([]);
    expect((await verify(signed)).statusCode).toBe(200);
    expect((onboarding as RecordingOnboarding).accounts).toEqual([PAYER]);
  });

  it('runs onboarding on every sign-in (it skips what is already done itself)', async () => {
    const { verify, signedIn, onboarding } = await setup();
    await verify(await signedIn());
    await verify(await signedIn());
    expect((onboarding as RecordingOnboarding).accounts).toEqual([PAYER, PAYER]);
  });

  it('still signs in over HTTP when the faucet relayer is down, and tries again next time', async () => {
    const relayer = new EdgeRelayer();
    relayer.down = true;
    const faucet = new NearTestnetFaucet({ relayer, usdcContract: NEAR.usdc });
    const { verify, signedIn } = await setup({ onboarding: faucet });
    expect((await verify(await signedIn())).statusCode).toBe(200);
    expect(relayer.calls).toBe(1);

    relayer.down = false;
    expect((await verify(await signedIn())).statusCode).toBe(200);
    expect(relayer.sent.map((s) => s.receiverId)).toEqual([PAYER, NEAR.usdc]);
  });

  it('still signs in when a faucet transaction fails on-chain', async () => {
    const relayer = new EdgeRelayer();
    relayer.receiptStatus = 'reverted';
    const faucet = new NearTestnetFaucet({ relayer, usdcContract: NEAR.usdc });
    const { verify, signedIn } = await setup({ onboarding: faucet });
    expect((await verify(await signedIn())).statusCode).toBe(200);
    // The create-account transfer failed, so it never went on to register and mint.
    expect(relayer.sent.map((s) => s.receiverId)).toEqual([PAYER]);
  });
});

describe('NEAR sign-in edge cases: expiry (AuthService clock)', () => {
  function service(clock: { now: Date }, onboarding?: NearOnboarding) {
    const repos = createMemoryRepositories();
    return new AuthService({
      users: repos.users,
      nonces: repos.nonces,
      tokens: new AccessTokens({ secret: 'k'.repeat(32), ttlSeconds: 3600, now: () => clock.now }),
      chainId: 1,
      domain: DOMAIN,
      rail: 'near',
      nonceTtlSeconds: 300,
      now: () => clock.now,
      ...(onboarding ? { onboarding, onboardingTimeoutMs: 50 } : {}),
    });
  }

  it('accepts a sign-in 1 ms before expiry and refuses it at the exact expiry', async () => {
    const clock = { now: new Date('2026-11-14T12:00:00.000Z') };
    const auth = service(clock);
    const first = await auth.createNonce(PAYER as never);
    const second = await auth.createNonce(PAYER as never);
    expect(first.expiresAt.toISOString()).toBe('2026-11-14T12:05:00.000Z');

    clock.now = new Date(first.expiresAt.getTime() - 1);
    const ok = await auth.verify(first.message, await signNep413(NEAR.payerKey, PAYER, first.message, first.nonce), PAYER_PUBLIC_KEY);
    expect(ok.user.walletAddress).toBe(PAYER);

    clock.now = new Date(second.expiresAt.getTime());
    await expect(
      auth.verify(second.message, await signNep413(NEAR.payerKey, PAYER, second.message, second.nonce), PAYER_PUBLIC_KEY),
    ).rejects.toMatchObject({ code: 'invalid_siwe_message', statusCode: 401 });
  });

  it("doesn't extend an expired nonce when the signer rewrites the message's Expiration Time", async () => {
    const clock = { now: new Date('2026-11-14T12:00:00.000Z') };
    const auth = service(clock);
    const { message, nonce } = await auth.createNonce(PAYER as never);
    clock.now = new Date('2026-11-14T12:06:00.000Z');
    const extended = message.replace(/Expiration Time: \S+/, 'Expiration Time: 2026-11-14T13:00:00.000Z');
    await expect(
      auth.verify(extended, await signNep413(NEAR.payerKey, PAYER, extended, nonce), PAYER_PUBLIC_KEY),
    ).rejects.toMatchObject({ code: 'invalid_nonce', statusCode: 401 });
  });

  it('refuses an expired nonce before it ever reaches onboarding', async () => {
    const clock = { now: new Date('2026-11-14T12:00:00.000Z') };
    const onboarding = new RecordingOnboarding();
    const auth = service(clock, onboarding);
    const { message, nonce } = await auth.createNonce(PAYER as never);
    clock.now = new Date('2026-11-14T12:10:00.000Z');
    await expect(auth.verify(message, await signNep413(NEAR.payerKey, PAYER, message, nonce), PAYER_PUBLIC_KEY)).rejects.toMatchObject({
      code: 'invalid_siwe_message',
    });
    expect(onboarding.accounts).toEqual([]);
  });

  it('requires the public key on the NEAR rail before looking at anything else', async () => {
    const auth = service({ now: new Date() });
    await expect(auth.verify('garbage', 'garbage')).rejects.toMatchObject({ code: 'invalid_request', statusCode: 400 });
  });
});

describe('NearTestnetFaucet edge cases', () => {
  it('shares one run between concurrent sign-ins of the same account', async () => {
    const relayer = new EdgeRelayer();
    const faucet = new NearTestnetFaucet({ relayer, usdcContract: NEAR.usdc });
    const first = faucet.onboard(PAYER);
    const second = faucet.onboard(PAYER);
    expect(second).toBe(first);
    await Promise.all([first, second]);
    expect(relayer.sent.map((s) => s.receiverId)).toEqual([PAYER, NEAR.usdc]);

    // Once done, a later sign-in runs again, and finds nothing left to do.
    await faucet.onboard(PAYER);
    expect(relayer.sent).toHaveLength(2);
  });

  it('runs separately for different accounts', async () => {
    const relayer = new EdgeRelayer();
    const faucet = new NearTestnetFaucet({ relayer, usdcContract: NEAR.usdc });
    await Promise.all([faucet.onboard(PAYER), faucet.onboard(STRANGER)]);
    expect(relayer.sent.map((s) => s.receiverId).sort()).toEqual([PAYER, STRANGER, NEAR.usdc, NEAR.usdc].sort());
  });

  it('logs, never throws, when a view call fails', async () => {
    const relayer = new EdgeRelayer();
    relayer.exists.add(PAYER);
    relayer.viewFails = true;
    const warnings: string[] = [];
    const faucet = new NearTestnetFaucet({ relayer, usdcContract: NEAR.usdc });
    faucet.useLogger({ info() {}, error() {}, warn: (_o: unknown, message?: string) => void warnings.push(message ?? '') } as never);
    await expect(faucet.onboard(PAYER)).resolves.toBeUndefined();
    expect(warnings).toEqual(['testnet onboarding failed']);
    expect(relayer.sent).toEqual([]);
  });

  it('retries the mint after a failed register-and-mint transaction', async () => {
    const relayer = new EdgeRelayer();
    relayer.exists.add(PAYER);
    relayer.receiptStatus = 'reverted';
    const faucet = new NearTestnetFaucet({ relayer, usdcContract: NEAR.usdc });
    await faucet.onboard(PAYER);
    expect(relayer.registered.has(PAYER)).toBe(false);

    relayer.receiptStatus = 'success';
    await faucet.onboard(PAYER);
    expect(relayer.registered.has(PAYER)).toBe(true);
    expect(relayer.sent.map((s) => s.receiverId)).toEqual([NEAR.usdc, NEAR.usdc]);
  });
});

/** A relayer that remembers what the faucet did, so a second run sees it. */
class EdgeRelayer implements NearRelayerClient {
  down = false;
  viewFails = false;
  receiptStatus: TxReceipt['status'] = 'success';
  calls = 0;
  readonly exists = new Set<string>();
  readonly registered = new Set<string>();
  readonly sent: { receiverId: string; actions: Action[] }[] = [];
  private readonly pending = new Map<string, () => void>();

  async accountExists(accountId: string): Promise<boolean> {
    this.calls++;
    if (this.down) throw new Error('fetch failed');
    return this.exists.has(accountId);
  }

  async view<T>(_contract: string, method: string, args?: { account_id?: string }): Promise<T> {
    if (this.viewFails) throw new Error('view failed');
    if (method === 'storage_balance_of') return (this.registered.has(args?.account_id ?? '') ? { total: '1' } : null) as T;
    if (method === 'storage_balance_bounds') return { min: '1250000000000000000000', max: null } as T;
    throw new Error(method);
  }

  async sendFromRelayer(receiverId: string, actions: Action[]): Promise<Hex> {
    this.sent.push({ receiverId, actions });
    const hash = `0x${this.sent.length.toString(16).padStart(64, '0')}` as Hex;
    this.pending.set(hash, () => {
      if (actions[0]?.transfer) this.exists.add(receiverId);
      const deposit = actions[0]?.functionCall;
      if (deposit?.methodName === 'storage_deposit') {
        this.registered.add((JSON.parse(Buffer.from(deposit.args).toString()) as { account_id: string }).account_id);
      }
    });
    return hash;
  }

  async waitForReceipt(txHash: Hex): Promise<TxReceipt> {
    if (this.receiptStatus === 'success') this.pending.get(txHash)?.();
    return { status: this.receiptStatus, blockNumber: 1n };
  }
}
