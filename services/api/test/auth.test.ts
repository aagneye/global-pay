import type { FastifyInstance } from 'fastify';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { createSiweMessage } from 'viem/siwe';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AuthService } from '../src/modules/auth/service.js';
import { AccessTokens } from '../src/modules/auth/tokens.js';
import { ANVIL } from './support/anvil.js';
import { buildTestApp, signIn } from './support/app.js';
import { createMemoryRepositories } from './support/memory-repositories.js';

const payer = privateKeyToAccount(ANVIL.accounts.payer.privateKey);
const stranger = privateKeyToAccount(generatePrivateKey());

describe('Sign-In with Ethereum over HTTP', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    ({ app } = await buildTestApp());
  });

  afterAll(async () => {
    await app.close();
  });

  async function requestNonce(address = payer.address) {
    const response = await app.inject({ method: 'POST', url: '/auth/nonce', payload: { address } });
    expect(response.statusCode).toBe(200);
    return response.json<{ nonce: string; message: string; expiresAt: string }>();
  }

  async function verify(message: string, signature: string) {
    return app.inject({ method: 'POST', url: '/auth/verify', payload: { message, signature } });
  }

  it('issues an EIP-4361 message for the app to sign', async () => {
    const { nonce, message } = await requestNonce(payer.address.toLowerCase() as typeof payer.address);
    expect(message).toContain('globalpay.local wants you to sign in with your Ethereum account:');
    expect(message).toContain(payer.address); // checksummed
    expect(message).toContain('Sign in to GlobalPay.');
    expect(message).toContain(`Chain ID: ${ANVIL.chainId}`);
    expect(message).toContain(`Nonce: ${nonce}`);
    expect(message).toContain('Expiration Time:');
  });

  it('signs in with a valid signature and returns a working token', async () => {
    const { message } = await requestNonce();
    const response = await verify(message, await payer.signMessage({ message }));

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body).toMatchObject({ tokenType: 'Bearer', user: { walletAddress: payer.address.toLowerCase() } });

    const status = await app.inject({
      method: 'GET',
      url: '/kyc/status',
      headers: { authorization: `Bearer ${body.token}` },
    });
    expect(status.statusCode).toBe(200);
  });

  it('returns the same user on every sign-in', async () => {
    const first = await signIn(app, ANVIL.accounts.payer.privateKey);
    const second = await signIn(app, ANVIL.accounts.payer.privateKey);
    expect(second.userId).toBe(first.userId);
  });

  it('refuses to reuse a nonce', async () => {
    const { message } = await requestNonce();
    const signature = await payer.signMessage({ message });
    expect((await verify(message, signature)).statusCode).toBe(200);

    const replay = await verify(message, signature);
    expect(replay.statusCode).toBe(401);
    expect(replay.json().error).toBe('invalid_nonce');
  });

  it('refuses a signature from another wallet', async () => {
    const { message } = await requestNonce();
    const response = await verify(message, await stranger.signMessage({ message }));
    expect(response.statusCode).toBe(401);
    expect(response.json().error).toBe('invalid_signature');
  });

  it("refuses another wallet's nonce, even with a valid signature", async () => {
    const { nonce, expiresAt } = await requestNonce(payer.address);
    const message = createSiweMessage({
      address: stranger.address,
      chainId: ANVIL.chainId,
      domain: 'globalpay.local',
      uri: 'https://globalpay.local',
      version: '1',
      nonce,
      expirationTime: new Date(expiresAt),
    });
    const response = await verify(message, await stranger.signMessage({ message }));
    expect(response.statusCode).toBe(401);
    expect(response.json().error).toBe('invalid_nonce');
  });

  it.each([
    ['another domain', (m: string) => m.replace('globalpay.local wants', 'evil.example wants')],
    ['another chain', (m: string) => m.replace(`Chain ID: ${ANVIL.chainId}`, 'Chain ID: 1')],
    ['another URI', (m: string) => m.replace('URI: https://globalpay.local', 'URI: https://evil.example')],
    ['no address', (m: string) => m.replace(/0x[0-9a-fA-F]{40}/, 'nobody')],
    ['not a SIWE message', () => 'hello'],
  ])('refuses a message for %s', async (_name, tamper) => {
    const { message } = await requestNonce();
    const changed = tamper(message);
    const response = await verify(changed, await payer.signMessage({ message: changed }));
    expect(response.statusCode).toBe(401);
    expect(response.json().error).toBe('invalid_siwe_message');
  });

  it('validates the request body', async () => {
    const response = await app.inject({ method: 'POST', url: '/auth/verify', payload: { message: 'x' } });
    expect(response.statusCode).toBe(400);
    expect(response.json().error).toBe('invalid_request');
  });
});

describe('AuthService expiry', () => {
  it('refuses a message signed after its nonce expired', async () => {
    let now = new Date('2026-11-12T00:00:00Z');
    const repos = createMemoryRepositories();
    const tokens = new AccessTokens({ secret: 'x'.repeat(32), ttlSeconds: 3600, now: () => now });
    const auth = new AuthService({
      users: repos.users,
      nonces: repos.nonces,
      tokens,
      chainId: ANVIL.chainId,
      domain: 'globalpay.local',
      nonceTtlSeconds: 300,
      now: () => now,
    });

    const { message } = await auth.createNonce(payer.address);
    const signature = await payer.signMessage({ message });
    now = new Date(now.getTime() + 301_000);

    await expect(auth.verify(message, signature)).rejects.toMatchObject({ code: 'invalid_siwe_message' });
  });
});

describe('AccessTokens', () => {
  const claims = { userId: 'user_1', walletAddress: payer.address.toLowerCase() as typeof payer.address };

  it('round-trips the claims', async () => {
    const tokens = new AccessTokens({ secret: 'a'.repeat(32), ttlSeconds: 60 });
    const { token } = await tokens.issue(claims);
    await expect(tokens.verify(token)).resolves.toEqual(claims);
  });

  it('rejects expired, foreign and malformed tokens', async () => {
    let now = new Date('2026-11-12T00:00:00Z');
    const tokens = new AccessTokens({ secret: 'a'.repeat(32), ttlSeconds: 60, now: () => now });
    const other = new AccessTokens({ secret: 'b'.repeat(32), ttlSeconds: 60, now: () => now });
    const { token } = await tokens.issue(claims);

    await expect(other.verify(token)).rejects.toMatchObject({ code: 'invalid_token', statusCode: 401 });
    await expect(tokens.verify('not.a.jwt')).rejects.toMatchObject({ code: 'invalid_token' });
    now = new Date(now.getTime() + 61_000);
    await expect(tokens.verify(token)).rejects.toMatchObject({ code: 'invalid_token' });
  });
});

describe('auth hook', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    ({ app } = await buildTestApp());
  });

  afterAll(async () => {
    await app.close();
  });

  it.each([
    ['no header', undefined, 'unauthorized'],
    ['a non-bearer header', 'Basic abc', 'invalid_token'],
    ['a bad token', 'Bearer abc.def.ghi', 'invalid_token'],
  ])('rejects a protected route with %s', async (_name, authorization, code) => {
    const response = await app.inject({
      method: 'GET',
      url: '/kyc/status',
      headers: authorization ? { authorization } : {},
    });
    expect(response.statusCode).toBe(401);
    expect(response.json().error).toBe(code);
  });

  it('leaves public routes open', async () => {
    expect((await app.inject({ method: 'GET', url: '/health' })).statusCode).toBe(200);
  });
});
