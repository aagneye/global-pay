import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { buildContainer } from '../src/container.js';
import { testEnv } from './helpers.js';

describe('http app', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildApp({ container: buildContainer(testEnv()), logger: false });
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
    expect(response.json().error).toBe('invalid_request');
  });

  it('returns 501 for routes planned in later iterations', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/auth/nonce',
      payload: { address: '0x000000000000000000000000000000000000dEaD' },
    });
    expect(response.statusCode).toBe(501);
    expect(response.json()).toMatchObject({ error: 'not_implemented' });
  });
});
