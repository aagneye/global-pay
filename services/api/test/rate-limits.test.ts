import { afterEach, describe, expect, it } from 'vitest';
import { privateKeyToAccount } from 'viem/accounts';
import { ANVIL } from './support/anvil.js';
import { type TestApp, buildTestApp, signIn } from './support/app.js';

const PAYER_KEY = ANVIL.accounts.payer.privateKey;
const OTHER_KEY = ANVIL.accounts.quoteSigner.privateKey;
const OPS_TOKEN = 'ops-token-for-tests-0123456789abcdef';

let testApp: TestApp | undefined;
afterEach(async () => {
  await testApp?.app.close();
  testApp = undefined;
});

async function setup(env: Record<string, string>) {
  testApp = await buildTestApp({ env });
  return testApp.app;
}

function expectRateLimited(response: { statusCode: number; headers: Record<string, unknown>; json(): unknown }) {
  expect(response.statusCode).toBe(429);
  expect(response.json()).toEqual({ error: 'rate_limited', message: expect.stringMatching(/^Too many requests/) });
  expect(Number(response.headers['retry-after'])).toBeGreaterThan(0);
}

describe('rate limits', () => {
  it('limits every route per IP by default, with the API error shape and Retry-After', async () => {
    const app = await setup({ RATE_LIMIT_MAX: '3' });
    const get = (url: string, remoteAddress = '203.0.113.1') => app.inject({ method: 'GET', url, remoteAddress });

    expect((await get('/me/balance')).statusCode).toBe(401);
    expect((await get('/payments/x')).statusCode).toBe(401);
    const unknown = await get('/nope');
    expect(unknown.statusCode).toBe(404);
    expect(unknown.json()).toEqual({ error: 'not_found', message: 'Route GET /nope not found' });
    expect(unknown.headers['x-ratelimit-remaining']).toBe('0');

    expectRateLimited(await get('/me/balance'));
    expectRateLimited(await get('/nope'));
    expect((await get('/me/balance', '203.0.113.2')).statusCode).toBe(401); // another client
    expect((await get('/health')).statusCode).toBe(200); // load balancer probes are never limited
  });

  it('gives sign-in its own, stricter budget per IP', async () => {
    const app = await setup({ RATE_LIMIT_AUTH_MAX: '2' });
    const { address } = privateKeyToAccount(PAYER_KEY);
    const nonce = (remoteAddress = '203.0.113.1') =>
      app.inject({ method: 'POST', url: '/auth/nonce', payload: { address }, remoteAddress });

    expect((await nonce()).statusCode).toBe(200);
    expect((await nonce()).statusCode).toBe(200);
    expectRateLimited(await nonce());
    expect((await nonce('203.0.113.2')).statusCode).toBe(200);
    // /auth/verify counts separately
    const verify = await app.inject({ method: 'POST', url: '/auth/verify', payload: { message: 'x', signature: '0x00' }, remoteAddress: '203.0.113.1' });
    expect(verify.statusCode).not.toBe(429);
  });

  it('limits quotes and payments per signed-in user', async () => {
    const app = await setup({ RATE_LIMIT_PAYMENTS_MAX: '2' });
    const payer = await signIn(app, PAYER_KEY);
    const other = await signIn(app, OTHER_KEY);
    const quote = (session: typeof payer) =>
      app.inject({ method: 'POST', url: '/quotes', headers: session.auth, payload: { payer: session.address, qrPayload: 'not a qr' } });

    expect((await quote(payer)).statusCode).not.toBe(429);
    expect((await quote(payer)).statusCode).not.toBe(429);
    expectRateLimited(await quote(payer));
    // Same IP, different user: its own budget.
    expect((await quote(other)).statusCode).not.toBe(429);
    // POST /payments has a budget of its own.
    const payment = await app.inject({ method: 'POST', url: '/payments', headers: payer.auth, payload: {} });
    expect(payment.statusCode).toBe(400);
  });

  it('limits the tap-to-pay routes and device registration per user', async () => {
    const app = await setup({ RATE_LIMIT_P2P_MAX: '1', RATE_LIMIT_DEVICES_MAX: '1' });
    const { auth } = await signIn(app, PAYER_KEY);
    const post = (url: string, payload: object) => app.inject({ method: 'POST', url, headers: auth, payload });

    expect((await post('/p2p/requests/r1/claim', { challenge: '0x00' })).statusCode).toBe(400);
    expectRateLimited(await post('/p2p/requests/r1/claim', { challenge: '0x00' }));
    expect((await post('/p2p/requests/r1/tap', { deviceId: 'd', signature: '0x00' })).statusCode).not.toBe(429);
    expect((await post('/devices', { platform: 'android' })).statusCode).toBe(400);
    expectRateLimited(await post('/devices', { platform: 'android' }));
  });

  it('limits webhooks per IP', async () => {
    const app = await setup({ RATE_LIMIT_WEBHOOKS_MAX: '1' });
    const hook = () => app.inject({ method: 'POST', url: '/webhooks/payouts/simulated', payload: {} });
    expect((await hook()).statusCode).not.toBe(429);
    expectRateLimited(await hook());
  });

  it('counts wrong operator tokens against the operator API limit', async () => {
    const app = await setup({ OPS_API_TOKEN: OPS_TOKEN, RATE_LIMIT_OPS_MAX: '2' });
    const health = (token: string) => app.inject({ method: 'GET', url: '/ops/api/health', headers: { 'x-ops-token': token } });
    expect((await health('wrong')).statusCode).toBe(401);
    expect((await health('wrong')).statusCode).toBe(401);
    expectRateLimited(await health(OPS_TOKEN));
    expect((await app.inject({ method: 'GET', url: '/ops' })).statusCode).toBe(200); // the page is under the global limit
  });

  it('can be turned off', async () => {
    const app = await setup({ RATE_LIMIT_ENABLED: 'false', RATE_LIMIT_MAX: '1' });
    for (let i = 0; i < 3; i++) expect((await app.inject({ method: 'GET', url: '/me/balance' })).statusCode).toBe(401);
  });
});
