import { afterEach, describe, expect, it } from 'vitest';
import { SimulatedPromptPayProvider } from '../src/adapters/payouts/simulated-promptpay-provider.js';
import type { Adapters } from '../src/container.js';
import { buildPromptPayQr } from '../src/lib/promptpay/build.js';
import type { PayoutRequest, PayoutResult } from '../src/ports/payout-provider.js';
import { ANVIL } from './support/anvil.js';
import { type TestApp, buildTestApp, createQuote, signAuthorization, signInVerified, submitPayment } from './support/app.js';

const PAYER_KEY = ANVIL.accounts.payer.privateKey;
const TOKEN = 'ops-token-for-tests-0123456789abcdef';
const qr = buildPromptPayQr({
  kind: 'merchant',
  targetType: 'biller',
  targetId: '099999999999901',
  amount: { currency: 'THB', minor: 100_00n },
});

/** A partner that never answers clearly: create times out, and it has no record of the payout. */
class SilentPartner extends SimulatedPromptPayProvider {
  found: PayoutResult | null = null;
  constructor() {
    super({ delayMs: 0, failureRate: 0 });
  }
  override async createPayout(_request: PayoutRequest): Promise<PayoutResult> {
    return { status: 'unknown', reason: 'Partner timed out' };
  }
  override async findByIdempotencyKey(): Promise<PayoutResult | null> {
    return this.found;
  }
}

let testApp: TestApp | undefined;
afterEach(async () => {
  await testApp?.app.close();
  testApp = undefined;
});

async function setup(env: Record<string, string> = {}, adapters: Partial<Adapters> = {}) {
  testApp = await buildTestApp({
    env: { INDEXER_CONFIRMATIONS: '0', PAYOUT_DELAY_MS: '0', OPS_API_TOKEN: TOKEN, ...env },
    adapters,
  });
  const { app, container, repos } = testApp;
  const session = await signInVerified(app, PAYER_KEY);

  /** A payment that's paid on-chain and has gone through the payout worker `ticks` times. */
  async function paid(ticks = 2): Promise<string> {
    const quote = await createQuote(app, session, qr);
    const response = await submitPayment(app, session, quote, await signAuthorization(PAYER_KEY, quote));
    await container.workers.indexer.tick();
    for (let i = 0; i < ticks; i++) await container.workers.payouts.tick();
    return response.json().id;
  }
  const ops = (method: 'GET' | 'POST', url: string, payload?: object, token: string | null = TOKEN) =>
    app.inject({ method, url: `/ops/api${url}`, headers: token ? { 'x-ops-token': token } : {}, ...(payload ? { payload } : {}) });
  const by = { actor: 'Somchai', note: 'Checked with the partner' };
  return { ...testApp, session, paid, ops, by, payout: (id: string) => repos.state.payouts.get(id) };
}

describe('operator console', () => {
  it('is off without OPS_API_TOKEN', async () => {
    testApp = await buildTestApp();
    expect((await testApp.app.inject({ method: 'GET', url: '/ops' })).statusCode).toBe(404);
    expect((await testApp.app.inject({ method: 'GET', url: '/ops/api/health' })).statusCode).toBe(404);
  });

  it('needs the operator token; a user sign-in is not enough', async () => {
    const { ops, app, session } = await setup();
    expect((await ops('GET', '/health', undefined, null)).statusCode).toBe(401);
    expect((await ops('GET', '/health', undefined, 'wrong')).statusCode).toBe(401);
    const asUser = await app.inject({ method: 'GET', url: '/ops/api/health', headers: session.auth });
    expect(asUser.statusCode).toBe(401);
    expect((await ops('GET', '/health')).statusCode).toBe(200);
  });

  it('serves the page with a strict content security policy', async () => {
    const { app } = await setup();
    const page = await app.inject({ method: 'GET', url: '/ops' });
    expect(page.statusCode).toBe(200);
    expect(page.headers['content-type']).toMatch(/text\/html/);
    expect(page.headers['content-security-policy']).toContain("default-src 'self'");
    expect(page.body).toContain('/ops/ops.js');
    expect((await app.inject({ method: 'GET', url: '/ops/ops.js' })).statusCode).toBe(200);
  });

  it('lists an unclear payout, and escalates it after the time limit', async () => {
    const { paid, ops } = await setup({ PAYOUT_UNKNOWN_RATE: '1' });
    const id = await paid();

    const items = (await ops('GET', '/exceptions')).json().items;
    expect(items).toEqual([
      expect.objectContaining({
        kind: 'payout_unknown',
        escalated: false,
        paymentId: id,
        payoutStatus: 'UNKNOWN',
        amount: { currency: 'THB', minor: '10000' },
        lastError: 'Simulated unclear outcome (PAYOUT_UNKNOWN_RATE)',
      }),
    ]);
  });

  it('flags UNKNOWN payouts as escalated once they are old enough', async () => {
    const { paid, ops } = await setup({ PAYOUT_UNKNOWN_RATE: '1', OPS_ESCALATE_AFTER_MS: '0' });
    await paid();
    expect((await ops('GET', '/exceptions')).json().items[0]).toMatchObject({ escalated: true });
  });

  it('marks an unclear payout paid with a reference; the worker then settles it', async () => {
    const { paid, ops, by, payout, container, repos } = await setup({ PAYOUT_UNKNOWN_RATE: '1' });
    const id = await paid();

    expect((await ops('POST', `/payouts/${id}/mark-paid`, by)).statusCode).toBe(400); // no reference
    const marked = await ops('POST', `/payouts/${id}/mark-paid`, { ...by, reference: 'KBANK-20261113-0042' });
    expect(marked.statusCode).toBe(200);
    expect(payout(id)).toMatchObject({ status: 'SUCCEEDED', providerReference: 'KBANK-20261113-0042' });
    expect(payout(id)?.lastError).toBeUndefined();

    await container.workers.payouts.tick();
    expect(repos.state.payments.get(id)?.status).toBe('SETTLED');

    const actions = (await ops('GET', '/actions')).json().items;
    expect(actions[0]).toMatchObject({ action: 'mark_paid', actor: 'Somchai', targetId: id, note: 'Checked with the partner' });
    expect((await ops('GET', '/exceptions')).json().items).toEqual([]);

    // Only UNKNOWN payouts can be resolved by hand.
    const again = await ops('POST', `/payouts/${id}/mark-paid`, { ...by, reference: 'KBANK-1' });
    expect(again.statusCode).toBe(409);
    expect(again.json().error).toBe('payout_changed');
  });

  it('approves a refund only after the cooling-off period, when the partner has no such payout', async () => {
    const silent = new SilentPartner();
    const early = await setup({}, { payouts: silent });
    const id = await early.paid();
    expect(early.payout(id)).toMatchObject({ status: 'UNKNOWN' });
    const tooEarly = await early.ops('POST', `/payouts/${id}/approve-refund`, early.by);
    expect(tooEarly.statusCode).toBe(409);
    expect(tooEarly.json().error).toBe('refund_too_early');
    await early.app.close();

    const { paid, ops, by, payout, container, repos, chain } = await setup({ OPS_REFUND_COOLOFF_MS: '0' }, { payouts: new SilentPartner() });
    const second = await paid();
    const approved = await ops('POST', `/payouts/${second}/approve-refund`, by);
    expect(approved.statusCode).toBe(200);
    expect(payout(second)).toMatchObject({ status: 'FAILED' });

    await container.workers.payouts.tick();
    expect(repos.state.payments.get(second)?.status).toBe('REFUNDED');
    expect(chain.sent.some((s) => s.functionName === 'refund')).toBe(true);
    expect(repos.state.opsActions.map((a) => a.action)).toEqual(['approve_refund']);
  });

  it('refuses to refund when the partner has the payout', async () => {
    const { paid, ops, by } = await setup({ PAYOUT_UNKNOWN_RATE: '1', OPS_REFUND_COOLOFF_MS: '0' });
    const id = await paid();
    const refused = await ops('POST', `/payouts/${id}/approve-refund`, by);
    expect(refused.statusCode).toBe(409);
    expect(refused.json().error).toBe('partner_has_payout');
  });

  it('re-checks the partner first, and leaves the decision to it when it now answers', async () => {
    const silent = new SilentPartner();
    const { paid, ops, by, payout, repos } = await setup({ OPS_REFUND_COOLOFF_MS: '0' }, { payouts: silent });
    const id = await paid();
    silent.found = { status: 'succeeded', providerRef: 'sim-late', reference: 'BANK-LATE' };

    const refused = await ops('POST', `/payouts/${id}/approve-refund`, by);
    expect(refused.statusCode).toBe(409);
    expect(refused.json().message).toMatch(/now reports it as SUCCEEDED/);
    expect(payout(id)).toMatchObject({ status: 'SUCCEEDED', providerReference: 'BANK-LATE' });
    expect(repos.state.opsActions).toHaveLength(0);
  });

  it('re-checks on request and records who asked', async () => {
    const { paid, ops, by, repos } = await setup({ PAYOUT_UNKNOWN_RATE: '1' });
    const id = await paid();
    const response = await ops('POST', `/payouts/${id}/recheck`, by);
    expect(response.statusCode).toBe(200);
    expect(response.json().payout.status).toBe('UNKNOWN');
    expect(repos.state.opsActions[0]).toMatchObject({ action: 'recheck', details: { from: 'UNKNOWN', to: 'UNKNOWN' } });

    const detail = (await ops('GET', `/payouts/${id}`)).json();
    expect(detail.payout.paymentId).toBe(id);
    expect(detail.events.length).toBeGreaterThan(0);
    expect(detail.actions).toHaveLength(1);
  });

  it('reports low gas, a low float and payout counts', async () => {
    const lowFloat = new SimulatedPromptPayProvider({ delayMs: 0, failureRate: 0, float: { currency: 'THB', minor: 1_000_00n } });
    const { ops, chain } = await setup({ OPS_MIN_PAYOUT_FLOAT_THB: '5000' }, { payouts: lowFloat });
    chain.relayerWei = 1n;

    const health = (await ops('GET', '/health')).json();
    expect(health.partner).toMatchObject({ name: 'simulated-promptpay', ok: false, float: { minor: '100000' } });
    expect(health.relayer).toMatchObject({ ok: false, wei: '1' });
    expect(health.payouts).toMatchObject({ PENDING: 0, UNKNOWN: 0 });
    expect(health.alerts).toEqual([
      'Payout float is low: 1000.00 THB',
      'Relayer is low on gas: 0x00000000000000000000000000000000000000aa',
    ]);
  });

  it('lists a payment stuck in PAID, and a settlement that keeps failing', async () => {
    const { paid, ops, chain, container, app, session, repos } = await setup();
    const settled = await paid(1); // payout sent; the next check finds it SUCCEEDED
    chain.failNextWrite = new Error('nonce too low');
    await container.workers.payouts.tick();

    // A second payment the worker hasn't picked up.
    const quote = await createQuote(app, session, qr);
    const waiting = await submitPayment(app, session, quote, await signAuthorization(PAYER_KEY, quote));
    await container.workers.indexer.tick();
    repos.state.payments.get(waiting.json().id)!.updatedAt = new Date(Date.now() - 10 * 60_000);

    const kinds = (await ops('GET', '/exceptions')).json().items.map((i: { kind: string; paymentId: string }) => [i.kind, i.paymentId === settled]);
    expect(kinds).toEqual([
      ['paid_without_payout', false],
      ['resolution_stuck', true],
    ]);
  });
});
