import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ANVIL } from './support/anvil.js';
import { buildTestApp, signIn } from './support/app.js';

describe('http app', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    ({ app } = await buildTestApp());
  });

  afterAll(async () => {
    await app.close();
  });

  it('reports health', async () => {
    const response = await app.inject({ method: 'GET', url: '/health' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: 'ok' });
  });

  it('validates request bodies before calling services', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/auth/nonce',
      payload: { address: 'not-an-address' },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      error: 'invalid_request',
      issues: [{ path: '/address', message: 'expected a 0x-prefixed 20-byte address' }],
    });
  });

  it('returns 501 for routes planned in later iterations', async () => {
    const { auth } = await signIn(app, ANVIL.accounts.payer.privateKey);
    for (const url of ['/me/balance', '/me/payments', '/payments/abc']) {
      const response = await app.inject({ method: 'GET', url, headers: auth });
      expect(response.statusCode, url).toBe(501);
      expect(response.json()).toMatchObject({ error: 'not_implemented' });
    }
  });

  it('returns 404 for unknown routes', async () => {
    expect((await app.inject({ method: 'GET', url: '/nope' })).statusCode).toBe(404);
  });
});

describe('OpenAPI', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    ({ app } = await buildTestApp());
  });

  afterAll(async () => {
    await app.close();
  });

  it('serves the spec with every route, schemas and bearer auth', async () => {
    const response = await app.inject({ method: 'GET', url: '/docs/json' });
    expect(response.statusCode).toBe(200);
    const spec = response.json();

    expect(spec.openapi).toBe('3.0.3');
    expect(spec.components.securitySchemes.bearerAuth).toMatchObject({ type: 'http', scheme: 'bearer' });
    expect(Object.keys(spec.paths).sort()).toEqual([
      '/auth/nonce',
      '/auth/verify',
      '/health',
      '/kyc/start',
      '/kyc/status',
      '/me/balance',
      '/me/payments',
      '/payments',
      '/payments/{id}',
      '/quotes',
    ]);

    expect(spec.paths['/kyc/status'].get.security).toEqual([{ bearerAuth: [] }]);
    const nonce = spec.paths['/auth/nonce'].post;
    expect(nonce.security).toBeUndefined();
    expect(nonce.requestBody.content['application/json'].schema.required).toEqual(['address']);

    const quotes = spec.paths['/quotes'].post;
    expect(quotes.security).toEqual([{ bearerAuth: [] }]);
    const body = quotes.requestBody.content['application/json'].schema;
    expect(body.required).toEqual(['payer', 'qrPayload']);
    expect(body.properties.fiatAmountMinor).toMatchObject({ type: 'string', pattern: '^\\d+$' });
    const created = quotes.responses['201'].content['application/json'].schema;
    expect(Object.keys(created.properties)).toEqual(
      expect.arrayContaining(['quote', 'signature', 'pricing', 'authorizationToSign']),
    );
  });

  it('serves the docs UI', async () => {
    const response = await app.inject({ method: 'GET', url: '/docs/' });
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('text/html');
  });
});
