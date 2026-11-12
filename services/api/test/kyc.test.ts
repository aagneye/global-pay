import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MockKycProvider } from '../src/adapters/kyc/mock-kyc-provider.js';
import { LIMITS_BY_TIER, checkSpendingLimit, effectiveTier } from '../src/domain/user.js';
import { KycService } from '../src/modules/kyc/service.js';
import { ANVIL } from './support/anvil.js';
import { buildTestApp, signIn } from './support/app.js';
import { createMemoryRepositories } from './support/memory-repositories.js';

describe('KycService with the mock provider', () => {
  function service() {
    const repos = createMemoryRepositories();
    return { kyc: new KycService({ provider: new MockKycProvider(), records: repos.kyc }), repos };
  }

  it('goes NOT_STARTED → PENDING → APPROVED at tier 1', async () => {
    const { kyc, repos } = service();

    await expect(kyc.status('user_1')).resolves.toMatchObject({ status: 'NOT_STARTED', tier: 0 });

    const started = await kyc.start('user_1');
    expect(started).toMatchObject({ status: 'PENDING', tier: 0 });
    expect(started.session?.sessionToken).toMatch(/^mock_[0-9a-f]{32}$/);

    const approved = await kyc.status('user_1');
    expect(approved).toEqual({ status: 'APPROVED', tier: 1, limits: LIMITS_BY_TIER[1] });
    expect(repos.state.kyc.get('user_1')).toMatchObject({ provider: 'mock', providerRef: 'mock-user_1' });
  });

  it('does not restart an approved verification', async () => {
    const { kyc } = service();
    await kyc.start('user_1');
    await kyc.status('user_1');

    await expect(kyc.start('user_1')).resolves.toMatchObject({ status: 'APPROVED', tier: 1, session: null });
  });
});

describe('spending limits', () => {
  it('grants a tier only when approved', () => {
    const record = { userId: 'u', provider: 'mock', tier: 1 as const };
    expect(effectiveTier(null)).toBe(0);
    expect(effectiveTier({ ...record, status: 'PENDING' })).toBe(0);
    expect(effectiveTier({ ...record, status: 'REJECTED' })).toBe(0);
    expect(effectiveTier({ ...record, status: 'APPROVED' })).toBe(1);
  });

  it('enforces the per-payment and rolling daily limits', () => {
    const { perPayment, perDay } = LIMITS_BY_TIER[1];
    expect(checkSpendingLimit(0, 1n, 0n)).toEqual({ code: 'kyc_required' });
    expect(checkSpendingLimit(1, perPayment, 0n)).toBeNull();
    expect(checkSpendingLimit(1, perPayment + 1n, 0n)).toEqual({ code: 'payment_limit_exceeded', limit: perPayment });
    expect(checkSpendingLimit(1, 100n, perDay - 100n)).toBeNull();
    expect(checkSpendingLimit(1, 101n, perDay - 100n)).toEqual({
      code: 'daily_limit_exceeded',
      limit: perDay,
      remaining: 100n,
    });
    expect(checkSpendingLimit(2, perPayment + 1n, 0n)).toBeNull();
  });
});

describe('KYC over HTTP', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    ({ app } = await buildTestApp());
  });

  afterAll(async () => {
    await app.close();
  });

  it('starts verification and reports the tier with its limits as strings', async () => {
    const { auth } = await signIn(app, ANVIL.accounts.payer.privateKey);

    const start = await app.inject({ method: 'POST', url: '/kyc/start', headers: auth });
    expect(start.statusCode).toBe(200);
    expect(start.json()).toMatchObject({ status: 'PENDING', tier: 0, session: { provider: 'mock' } });

    const status = await app.inject({ method: 'GET', url: '/kyc/status', headers: auth });
    expect(status.json()).toEqual({
      status: 'APPROVED',
      tier: 1,
      limits: { perPayment: '500000', perDay: '2000000' },
    });
  });
});
