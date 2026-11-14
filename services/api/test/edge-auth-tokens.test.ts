import { SignJWT, UnsecuredJWT } from 'jose';
import { KeyPairSigner } from 'near-api-js';
import { privateKeyToAccount } from 'viem/accounts';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AccessTokens } from '../src/modules/auth/tokens.js';
import { ANVIL } from './support/anvil.js';
import { type TestApp, buildTestApp, signIn } from './support/app.js';
import { FakeNearGateway, RecordingOnboarding } from './support/fake-near.js';
import { NEAR, implicitAccount, nearEnv, nearTestKey } from './support/near.js';
import { testEnv } from './helpers.js';

vi.setConfig({ testTimeout: 30_000 });

const SECRET = 'a'.repeat(32);
const KEY = new TextEncoder().encode(SECRET);
/** JWT_SECRET in test/helpers.ts: the key the test app signs with. */
const APP_SECRET = new TextEncoder().encode('test-secret-test-secret-test-secret-00');
const WALLET = ANVIL.accounts.payer.address.toLowerCase() as `0x${string}`;
const claims = { userId: 'user_1', walletAddress: WALLET };
const T0 = new Date('2026-11-14T12:00:00.000Z');
const epoch = (date: Date) => Math.floor(date.getTime() / 1000);

/** A token like AccessTokens.issue's, with `change` applied. */
function forge(change: { alg?: string; iss?: string; aud?: string; sub?: string | null; wallet?: unknown; exp?: number; key?: Uint8Array } = {}) {
  const payload: Record<string, unknown> = { wallet: 'wallet' in change ? change.wallet : WALLET };
  const jwt = new SignJWT(payload)
    .setProtectedHeader({ alg: change.alg ?? 'HS256' })
    .setIssuer(change.iss ?? 'globalpay-api')
    .setAudience(change.aud ?? 'globalpay-app')
    .setIssuedAt(epoch(T0))
    .setExpirationTime(change.exp ?? epoch(T0) + 60);
  if (change.sub !== null) jwt.setSubject(change.sub ?? 'user_1');
  return jwt.sign(change.key ?? KEY);
}

describe('AccessTokens edge cases', () => {
  const tokens = (now = T0) => new AccessTokens({ secret: SECRET, ttlSeconds: 60, now: () => now });

  it('accepts a forged-shape token only when every claim and the key match', async () => {
    await expect(tokens().verify(await forge())).resolves.toEqual(claims);
  });

  it.each([
    ['another issuer', { iss: 'someone-else' }],
    ['another audience', { aud: 'another-app' }],
    ['HS512 with the same secret', { alg: 'HS512' }],
    ['no subject', { sub: null }],
    ['no wallet claim', { wallet: undefined }],
    ['a numeric wallet claim', { wallet: 42 }],
    ['an already passed expiry', { exp: epoch(T0) - 1 }],
  ] as const)('refuses a token with %s', async (_name, change) => {
    await expect(tokens().verify(await forge(change as never))).rejects.toMatchObject({ code: 'invalid_token', statusCode: 401 });
  });

  it("refuses an unsigned (alg: none) token with the right claims", async () => {
    const unsigned = new UnsecuredJWT({ wallet: WALLET })
      .setSubject('user_1')
      .setIssuer('globalpay-api')
      .setAudience('globalpay-app')
      .setIssuedAt(epoch(T0))
      .setExpirationTime(epoch(T0) + 60)
      .encode();
    await expect(tokens().verify(unsigned)).rejects.toMatchObject({ code: 'invalid_token' });
  });

  it('refuses a token whose payload was swapped after signing', async () => {
    const { token } = await tokens().issue(claims);
    const [header, payload, signature] = token.split('.');
    const decoded = JSON.parse(Buffer.from(payload!, 'base64url').toString());
    const swapped = Buffer.from(JSON.stringify({ ...decoded, sub: 'user_2' })).toString('base64url');
    await expect(tokens().verify(`${header}.${swapped}.${signature}`)).rejects.toMatchObject({ code: 'invalid_token' });
    await expect(tokens().verify(`${header}.${payload}.`)).rejects.toMatchObject({ code: 'invalid_token' });
    await expect(tokens().verify(`${header}.${payload}`)).rejects.toMatchObject({ code: 'invalid_token' });
    await expect(tokens().verify('')).rejects.toMatchObject({ code: 'invalid_token' });
  });

  it('is valid until the last second and refuses it at the exact expiry', async () => {
    const { token, expiresAt } = await tokens().issue(claims);
    expect(expiresAt.getTime() - T0.getTime()).toBe(60_000);
    await expect(tokens(new Date(expiresAt.getTime() - 1)).verify(token)).resolves.toEqual(claims);
    await expect(tokens(expiresAt).verify(token)).rejects.toMatchObject({ code: 'invalid_token' });
  });

  it('rounds the issue time down to whole seconds', async () => {
    const { token, expiresAt } = await tokens(new Date(T0.getTime() + 999)).issue(claims);
    expect(expiresAt.toISOString()).toBe('2026-11-14T12:01:00.000Z');
    await expect(tokens(new Date(T0.getTime() + 59_999)).verify(token)).resolves.toEqual(claims);
  });
});

let testApp: TestApp | undefined;
afterEach(async () => {
  await testApp?.app.close();
  testApp = undefined;
});

describe('access tokens over HTTP', () => {
  it('refuses an expired token signed with the right key', async () => {
    testApp = await buildTestApp();
    const expired = await forge({ key: APP_SECRET, exp: epoch(new Date()) - 5 });
    const response = await testApp.app.inject({ method: 'GET', url: '/kyc/status', headers: { authorization: `Bearer ${expired}` } });
    expect(response.statusCode).toBe(401);
    expect(response.json().error).toBe('invalid_token');
  });

  it('refuses a real token once its payload is tampered with', async () => {
    testApp = await buildTestApp();
    const { token } = await signIn(testApp.app, ANVIL.accounts.payer.privateKey);
    const [header, payload, signature] = token.split('.');
    const decoded = JSON.parse(Buffer.from(payload!, 'base64url').toString());
    const tampered = Buffer.from(JSON.stringify({ ...decoded, exp: decoded.exp + 86_400 })).toString('base64url');
    const response = await testApp.app.inject({
      method: 'GET',
      url: '/kyc/status',
      headers: { authorization: `Bearer ${header}.${tampered}.${signature}` },
    });
    expect(response.statusCode).toBe(401);
    expect(response.json().error).toBe('invalid_token');
  });

  it.each([
    ['a lower-case scheme', (t: string) => `bearer ${t}`, 200],
    ['extra spaces after the scheme', (t: string) => `Bearer    ${t}`, 200],
    ['a second word after the token', (t: string) => `Bearer ${t} extra`, 401],
    ['no space after the scheme', (t: string) => `Bearer${t}`, 401],
    ['the token alone', (t: string) => t, 401],
    ['an empty bearer', () => 'Bearer ', 401],
  ])('handles an Authorization header with %s', async (_name, header, status) => {
    testApp = await buildTestApp();
    const { token } = await signIn(testApp.app, ANVIL.accounts.payer.privateKey);
    const response = await testApp.app.inject({ method: 'GET', url: '/kyc/status', headers: { authorization: header(token) } });
    expect(response.statusCode).toBe(status);
    if (status === 401) expect(response.json().error).toBe('invalid_token');
  });
});

describe('rate limits on sign-in', () => {
  const PAYER = implicitAccount(NEAR.payerKey);
  const PAYER_PUBLIC_KEY = NEAR.payerKey.getPublicKey().toString();

  async function nearApp(env: Record<string, string>) {
    testApp = await buildTestApp({
      env: nearEnv(env),
      adapters: { nearGateway: new FakeNearGateway(), nearOnboarding: new RecordingOnboarding() },
    });
    return testApp.app;
  }

  it('cuts off repeated bad signatures on /auth/verify, without touching the nonce budget', async () => {
    testApp = await buildTestApp({ env: { RATE_LIMIT_AUTH_MAX: '2' } });
    const { app } = testApp;
    const ip = '198.51.100.7';
    const bad = () => app.inject({ method: 'POST', url: '/auth/verify', payload: { message: 'x', signature: '0x00' }, remoteAddress: ip });
    expect((await bad()).statusCode).toBe(401);
    expect((await bad()).statusCode).toBe(401);
    const limited = await bad();
    expect(limited.statusCode).toBe(429);
    expect(limited.json().error).toBe('rate_limited');

    const { address } = privateKeyToAccount(ANVIL.accounts.payer.privateKey);
    const nonce = await app.inject({ method: 'POST', url: '/auth/nonce', payload: { address }, remoteAddress: ip });
    expect(nonce.statusCode).toBe(200);
  });

  it('refuses even a valid NEAR signature once the IP is limited, without spending its nonce', async () => {
    const app = await nearApp({ RATE_LIMIT_AUTH_MAX: '1' });
    const { message, nonce } = (await app.inject({ method: 'POST', url: '/auth/nonce', payload: { address: PAYER }, remoteAddress: '198.51.100.8' })).json();
    const signed = await new KeyPairSigner(NEAR.payerKey).signNep413Message(PAYER, {
      message,
      recipient: 'globalpay.local',
      nonce: Buffer.from(nonce, 'hex'),
    });
    const payload = { message, signature: Buffer.from(signed.signature).toString('base64'), publicKey: PAYER_PUBLIC_KEY };
    const verify = (remoteAddress: string) => app.inject({ method: 'POST', url: '/auth/verify', payload, remoteAddress });

    expect((await app.inject({ method: 'POST', url: '/auth/verify', payload: { ...payload, signature: 'AAAA' }, remoteAddress: '198.51.100.8' })).statusCode).toBe(401);
    expect((await verify('198.51.100.8')).statusCode).toBe(429);
    // The limited attempt never reached the nonce: the same signed message works from another network.
    expect((await verify('198.51.100.9')).statusCode).toBe(200);
  });

  it('limits NEAR sign-in per IP, not per account', async () => {
    const app = await nearApp({ RATE_LIMIT_AUTH_MAX: '1' });
    const nonce = (address: string) => app.inject({ method: 'POST', url: '/auth/nonce', payload: { address }, remoteAddress: '198.51.100.10' });
    expect((await nonce(PAYER)).statusCode).toBe(200);
    expect((await nonce(implicitAccount(nearTestKey('edge-other')))).statusCode).toBe(429);
  });

  it('counts refused nonce requests (bad addresses) against the budget too', async () => {
    const app = await nearApp({ RATE_LIMIT_AUTH_MAX: '2' });
    const nonce = (address: string) => app.inject({ method: 'POST', url: '/auth/nonce', payload: { address }, remoteAddress: '198.51.100.11' });
    expect((await nonce('not-an-account')).statusCode).toBe(400);
    expect((await nonce('still-not')).statusCode).toBe(400);
    expect((await nonce(PAYER)).statusCode).toBe(429);
  });

  it('keeps sign-in outside the global budget', async () => {
    testApp = await buildTestApp({ env: { RATE_LIMIT_MAX: '1' } });
    const { address } = privateKeyToAccount(ANVIL.accounts.payer.privateKey);
    for (let i = 0; i < 3; i++) {
      expect((await testApp.app.inject({ method: 'POST', url: '/auth/nonce', payload: { address } })).statusCode).toBe(200);
    }
    expect((await testApp.app.inject({ method: 'GET', url: '/me/balance' })).statusCode).toBe(401);
    expect((await testApp.app.inject({ method: 'GET', url: '/me/balance' })).statusCode).toBe(429);
  });
});

describe('auth settings', () => {
  it.each([
    ['299', false],
    ['300', true],
    ['604800', true],
    ['604801', false],
    ['1.5', false],
    ['soon', false],
  ])('JWT_TTL_SECONDS=%s accepted: %s', (value, ok) => {
    const load = () => testEnv({ JWT_TTL_SECONDS: value });
    if (ok) expect(load().JWT_TTL_SECONDS).toBe(Number(value));
    else expect(load).toThrow(/JWT_TTL_SECONDS/);
  });

  it('needs a JWT secret of at least 32 characters, in any environment', () => {
    expect(() => testEnv({ JWT_SECRET: 'x'.repeat(31) })).toThrow(/at least 32 characters/);
    expect(testEnv({ JWT_SECRET: 'x'.repeat(32) }).JWT_SECRET).toHaveLength(32);
  });

  it('refuses a zero sign-in budget or a sub-second window', () => {
    expect(() => testEnv({ RATE_LIMIT_AUTH_MAX: '0' })).toThrow(/RATE_LIMIT_AUTH_MAX/);
    expect(() => testEnv({ RATE_LIMIT_WINDOW_MS: '999' })).toThrow(/RATE_LIMIT_WINDOW_MS/);
  });

  it('refuses the faucet on NEAR mainnet in production for both reasons', () => {
    const production = {
      NODE_ENV: 'production',
      JWT_SECRET: 'q7Vb2mZ9xK4tR1wN8cY3hJ6pL0dF5gSa',
      CHAIN_ID: '8453',
      RPC_URL: 'https://mainnet.base.org',
      PAYOUT_PROVIDER: 'xendit',
      XENDIT_SECRET_KEY: 'xnd_production_x',
      XENDIT_CALLBACK_TOKEN: 'cb_live_x',
      MERCHANT_QR_ONLY: 'true',
      SIWE_DOMAIN: 'api.globalpay.example',
      ONRAMP_PROVIDER: 'moonpay',
      MOONPAY_PUBLISHABLE_KEY: 'pk_live_x',
      MOONPAY_SECRET_KEY: 'sk_live_x',
      MOONPAY_WEBHOOK_KEY: 'wk_live_x',
      MOONPAY_WIDGET_URL: 'https://buy.moonpay.com',
      ...nearEnv({ NEAR_NETWORK: 'mainnet', NEAR_RPC_URL: 'https://free.rpc.fastnear.com' }),
    };
    expect(testEnv(production).NEAR_TESTNET_FAUCET).toBe(false);
    const load = () => testEnv({ ...production, NEAR_TESTNET_FAUCET: 'true' });
    expect(load).toThrow(/works on NEAR_NETWORK=testnet only/);
    expect(load).toThrow(/gives away test tokens and is refused in production/);
  });
});
