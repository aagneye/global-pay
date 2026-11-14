import { afterEach, describe, expect, it } from 'vitest';
import { privateKeyToAccount } from 'viem/accounts';
import { ANVIL } from './support/anvil.js';
import { type TestApp, buildTestApp } from './support/app.js';

const OPS_TOKEN = 'ops-token-for-tests-0123456789abcdef';
const ADDRESS = privateKeyToAccount(ANVIL.accounts.payer.privateKey).address;

let testApp: TestApp | undefined;
afterEach(async () => {
  await testApp?.app.close();
  testApp = undefined;
});

async function setup(env: Record<string, string> = {}) {
  testApp = await buildTestApp({ env });
  return testApp.app;
}

describe('security headers', () => {
  it('are on API responses, errors included', async () => {
    const app = await setup();
    for (const response of [
      await app.inject({ method: 'GET', url: '/health' }),
      await app.inject({ method: 'GET', url: '/me/balance' }), // 401
      await app.inject({ method: 'GET', url: '/nope' }), // 404
    ]) {
      expect(response.headers).toMatchObject({
        'x-content-type-options': 'nosniff',
        'referrer-policy': 'no-referrer',
        'x-frame-options': 'DENY',
        'content-security-policy': "default-src 'none'; frame-ancestors 'none'",
        'cache-control': 'no-store',
      });
    }
  });

  it('leave the docs page loadable and keep the operator page its own policy', async () => {
    const app = await setup({ OPS_API_TOKEN: OPS_TOKEN });
    const docs = await app.inject({ method: 'GET', url: '/docs/' });
    expect(docs.statusCode).toBe(200);
    expect(docs.headers['content-type']).toMatch(/^text\/html/);
    expect(docs.headers['x-content-type-options']).toBe('nosniff');
    expect(docs.headers['content-security-policy']).toBeUndefined(); // Swagger UI runs its own scripts
    const spec = await app.inject({ method: 'GET', url: '/docs/json' });
    expect(spec.statusCode).toBe(200);
    expect(spec.json().openapi).toBe('3.0.3');

    const ops = await app.inject({ method: 'GET', url: '/ops' });
    expect(ops.headers['content-security-policy']).toBe("default-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'");
    expect(ops.headers['x-content-type-options']).toBe('nosniff');
  });
});

describe('body size limit', () => {
  const padded = (bytes: number) => ({ address: ADDRESS, padding: 'x'.repeat(bytes) });

  it('refuses bodies over 64 KiB by default', async () => {
    const app = await setup();
    expect((await app.inject({ method: 'POST', url: '/auth/nonce', payload: padded(60 * 1024) })).statusCode).toBe(200);
    const tooBig = await app.inject({ method: 'POST', url: '/auth/nonce', payload: padded(65 * 1024) });
    expect(tooBig.statusCode).toBe(413);
    expect(tooBig.json()).toMatchObject({ error: 'payload_too_large' });
  });

  it('follows BODY_LIMIT_BYTES, raw webhook bodies included', async () => {
    const app = await setup({ BODY_LIMIT_BYTES: '2048' });
    expect((await app.inject({ method: 'POST', url: '/auth/nonce', payload: padded(1_000) })).statusCode).toBe(200);
    expect((await app.inject({ method: 'POST', url: '/auth/nonce', payload: padded(3_000) })).statusCode).toBe(413);
    const webhook = await app.inject({ method: 'POST', url: '/webhooks/onramp/simulated', payload: { data: 'x'.repeat(3_000) } });
    expect(webhook.statusCode).toBe(413);
  });
});
