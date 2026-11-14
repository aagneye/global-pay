import { describe, expect, it } from 'vitest';
import { SimulatedPromptPayProvider } from '../src/adapters/payouts/simulated-promptpay-provider.js';
import { SimulatedUpiProvider } from '../src/adapters/payouts/simulated-upi-provider.js';
import { buildPromptPayQr } from '../src/lib/promptpay/build.js';
import { parsePromptPayQr } from '../src/lib/promptpay/parse.js';
import { buildUpiQr } from '../src/lib/upi/build.js';
import { parseUpiQr } from '../src/lib/upi/parse.js';
import { PayoutRouter } from '../src/modules/payouts/payout-router.js';
import { PayoutTracker } from '../src/modules/payouts/payout-tracker.js';
import { createMemoryRepositories, seedPayment } from './support/memory-repositories.js';

const upi = parseUpiQr(buildUpiQr({ vpa: 'chai.stall@okaxis', name: 'Ravi Chai', amountMinor: 250_00n, merchantCode: '5812' }));
const INR_250 = { currency: 'INR' as const, minor: 250_00n };
const promptpay = parsePromptPayQr(buildPromptPayQr({ kind: 'merchant', targetType: 'biller', targetId: '099999999999901' }));

describe('SimulatedUpiProvider', () => {
  it('pays UPI merchants in INR, with a 12-digit UTR', async () => {
    let clock = 1_000;
    const provider = new SimulatedUpiProvider({ delayMs: 100, failureRate: 0, now: () => clock });
    expect(provider.name).toBe('simulated-upi');
    expect(provider.supports(upi)).toBe(true);
    expect(provider.supports(promptpay)).toBe(false);
    await expect(provider.getBalance()).resolves.toBeNull();

    const created = await provider.createPayout({ idempotencyKey: 'p1', paymentId: 'p1', merchant: upi, amount: INR_250 });
    expect(created.status).toBe('pending');
    const ref = (created as { providerRef: string }).providerRef;
    await expect(provider.getPayout(ref)).resolves.toMatchObject({ status: 'pending' });
    clock += 100;
    const done = await provider.getPayout(ref);
    expect(done).toMatchObject({ status: 'succeeded', providerRef: ref });
    expect((done as { reference: string }).reference).toMatch(/^\d{12}$/);
    // Stable across calls and lookups.
    await expect(provider.findByIdempotencyKey('p1')).resolves.toEqual(done);
  });

  it('fails every payout at PAYOUT_FAILURE_RATE=1, and refuses non-UPI payouts', async () => {
    const provider = new SimulatedUpiProvider({ delayMs: 0, failureRate: 1 });
    const created = await provider.createPayout({ idempotencyKey: 'p2', paymentId: 'p2', merchant: upi, amount: INR_250 });
    await expect(provider.getPayout((created as { providerRef: string }).providerRef)).resolves.toMatchObject({ status: 'failed' });
    await expect(
      provider.createPayout({ idempotencyKey: 'p3', paymentId: 'p3', merchant: promptpay, amount: { currency: 'THB', minor: 1n } }),
    ).resolves.toMatchObject({ status: 'failed', providerStatus: 'UNSUPPORTED' });
  });
});

describe('PayoutRouter', () => {
  const thai = new SimulatedPromptPayProvider({ delayMs: 0, failureRate: 0 });
  const india = new SimulatedUpiProvider({ delayMs: 0, failureRate: 0 });
  const router = new PayoutRouter({ promptpay: thai, upi: india });

  it('picks the partner by merchant kind, and by name', () => {
    expect(router.forMerchant(upi)).toBe(india);
    expect(router.forMerchant(promptpay)).toBe(thai);
    expect(router.named('simulated-upi')).toBe(india);
    expect(router.named('simulated-promptpay')).toBe(thai);
    expect(router.named('xendit')).toBeUndefined();
    expect(new PayoutRouter({ promptpay: thai }).forMerchant(upi)).toBeUndefined();
  });

  it('lets the tracker pay a UPI merchant with the UPI partner', async () => {
    const repos = createMemoryRepositories();
    const tracker = new PayoutTracker({ payouts: repos.payouts, provider: thai, router, recheckMs: 0, pendingDeadlineMs: 60_000 });
    const payment = seedPayment(repos, { userId: 'u1', fiatMinor: 250_00n, status: 'PAYOUT_PENDING', createdAt: new Date() });
    const stored = repos.state.quotes.get(payment.quoteId)!;
    stored.quote = { ...stored.quote, fiat: INR_250, merchant: upi, merchantRef: 'upi:chai.stall@okaxis' };
    const item = (await repos.payments.findById(payment.id))!;

    await tracker.check(item);
    const payout = await tracker.check(item);
    expect(payout).toMatchObject({ provider: 'simulated-upi', status: 'SUCCEEDED', amount: { currency: 'INR', minor: 250_00n } });
    expect(payout.providerReference).toMatch(/^\d{12}$/);
  });
});
