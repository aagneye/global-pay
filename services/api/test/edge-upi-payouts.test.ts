import { afterEach, describe, expect, it, vi } from 'vitest';
import { SimulatedPromptPayProvider } from '../src/adapters/payouts/simulated-promptpay-provider.js';
import { SimulatedUpiProvider } from '../src/adapters/payouts/simulated-upi-provider.js';
import { FixedRateProvider } from '../src/adapters/rates/fixed-rate-provider.js';
import type { Adapters } from '../src/container.js';
import { buildPromptPayQr } from '../src/lib/promptpay/build.js';
import { buildUpiQr } from '../src/lib/upi/build.js';
import { parseUpiQr } from '../src/lib/upi/parse.js';
import { PayoutRouter } from '../src/modules/payouts/payout-router.js';
import { PayoutTracker } from '../src/modules/payouts/payout-tracker.js';
import type { RateProvider } from '../src/ports/rate-provider.js';
import { AppError } from '../src/shared/errors.js';
import { type TestApp, buildTestApp } from './support/app.js';
import { FakeNearGateway, RecordingOnboarding } from './support/fake-near.js';
import { createMemoryRepositories, seedPayment } from './support/memory-repositories.js';
import { NEAR, type NearPaymentJson, implicitAccount, nearEnv, nearSignIn, signNearPayment } from './support/near.js';

const PAYER = implicitAccount(NEAR.payerKey);
const chai250 = buildUpiQr({ vpa: 'chai.stall@okaxis', name: 'Ravi Chai', amountMinor: 250_00n, merchantCode: '5812' });
const shop = (amountMinor: bigint) => buildUpiQr({ vpa: 'shop@okaxis', amountMinor, merchantCode: '5411' });
const thai100 = buildPromptPayQr({ kind: 'merchant', targetType: 'biller', targetId: '099999999999901', amount: { currency: 'THB', minor: 100_00n } });
const upiMerchant = parseUpiQr(chai250);
const INR_250 = { currency: 'INR' as const, minor: 250_00n };
const RATES = { THB: 32_50000000n, INR: 88_00000000n };

vi.setConfig({ testTimeout: 30_000 });

let testApp: TestApp | undefined;

afterEach(async () => {
  await testApp?.app.close();
  testApp = undefined;
});

interface QuoteBody {
  quote: { quoteId: string; tokenAmount: string };
  nearPayment: NearPaymentJson;
}

async function setup(env: Record<string, string> = {}, adapters: Partial<Adapters> = {}) {
  const near = new FakeNearGateway();
  near.setAccessKey(PAYER, NEAR.payerKey.getPublicKey().toString(), 41n);
  testApp = await buildTestApp({
    env: nearEnv({ PAYOUT_DELAY_MS: '0', PAYOUT_FAILURE_RATE: '0', ...env }),
    adapters: { nearGateway: near, nearOnboarding: new RecordingOnboarding(), ...adapters },
  });
  const { app, container, repos } = testApp;
  const session = await nearSignIn(app);
  await app.inject({ method: 'POST', url: '/kyc/start', headers: session.auth });
  await app.inject({ method: 'GET', url: '/kyc/status', headers: session.auth });
  const quote = (qrPayload: string) =>
    app.inject({ method: 'POST', url: '/quotes', headers: session.auth, payload: { payer: PAYER, qrPayload } });
  async function pay(qrPayload: string) {
    const response = await quote(qrPayload);
    if (response.statusCode !== 201) throw new Error(`quote failed: ${response.body}`);
    const body = response.json<QuoteBody>();
    const signedDelegate = await signNearPayment(NEAR.payerKey, body.nearPayment);
    const paid = await app.inject({ method: 'POST', url: '/payments', headers: session.auth, payload: { quoteId: body.quote.quoteId, signedDelegate } });
    return { body, paid, signedDelegate };
  }
  const status = (id: string) => repos.state.payments.get(id)?.status;
  const view = async (id: string) => (await app.inject({ method: 'GET', url: `/payments/${id}`, headers: session.auth })).json();
  return { app, container, repos, near, session, quote, pay, status, view };
}

describe('UPI payouts on the NEAR rail: unclear outcomes', () => {
  it('never settles or refunds a UPI payment while its payout is UNKNOWN, and shows it as being checked', async () => {
    const upi = new SimulatedUpiProvider({ delayMs: 0, failureRate: 0, unknownRate: 1 });
    const { container, near, repos, pay, status, view } = await setup({}, { upiPayouts: upi });
    const { id } = (await pay(chai250)).paid.json<{ id: string }>();
    await container.workers.indexer.tick();

    for (let i = 0; i < 6; i++) await container.workers.payouts.tick();
    expect(status(id)).toBe('PAYOUT_PENDING');
    expect(repos.state.payouts.get(id)).toMatchObject({ status: 'UNKNOWN', provider: 'simulated-upi' });
    expect(repos.state.payouts.get(id)?.unknownSince).toBeInstanceOf(Date);
    expect(near.sent.map((s) => s.kind)).toEqual(['delegate']);
    const shown = await view(id);
    expect(shown).toMatchObject({ status: 'PAYOUT_PENDING', payout: { status: 'UNKNOWN', provider: 'simulated-upi' } });
    expect(shown.payout.reference).toBeUndefined();
  });

  // README: with the simulated partner, PAYOUT_UNKNOWN_RATE=1 "makes every outcome unclear", for UPI payouts too.
  it('PAYOUT_UNKNOWN_RATE=1 makes simulated UPI payouts unclear too, as it does PromptPay ones', async () => {
    const { container, near, repos, pay, status } = await setup({ PAYOUT_UNKNOWN_RATE: '1' });
    const { id } = (await pay(chai250)).paid.json<{ id: string }>();
    await container.workers.indexer.tick();
    for (let i = 0; i < 4; i++) await container.workers.payouts.tick();
    expect(status(id)).toBe('PAYOUT_PENDING');
    expect(repos.state.payouts.get(id)?.status).toBe('UNKNOWN');
    expect(near.sent.map((s) => s.kind)).toEqual(['delegate']);
  });

  it('shows a failed UPI payout as REFUNDED, with the reason, the refund transaction and no UTR', async () => {
    const { container, near, pay, status, view } = await setup({ PAYOUT_FAILURE_RATE: '1' });
    const { id } = (await pay(chai250)).paid.json<{ id: string }>();
    await container.workers.indexer.tick();
    for (let i = 0; i < 4 && status(id) !== 'REFUNDED'; i++) await container.workers.payouts.tick();

    const shown = await view(id);
    const refund = near.sent.find((s) => s.kind === 'refund');
    expect(shown).toMatchObject({
      status: 'REFUNDED',
      fiatCurrency: 'INR',
      payout: { status: 'FAILED', provider: 'simulated-upi' },
      transactions: { refund: { hash: refund?.hash, url: `https://testnet.nearblocks.io/txns/${refund?.hash}` } },
    });
    expect(shown.failureReason).toEqual(expect.any(String));
    expect(shown.payout.reference).toBeUndefined();
    expect(shown.transactions.settle).toBeUndefined();
  });

  it('keeps a slow UPI payout PENDING, with no reference, until the partner pays', async () => {
    const { container, near, pay, status, view } = await setup({ PAYOUT_DELAY_MS: '600000' });
    const { id } = (await pay(chai250)).paid.json<{ id: string }>();
    await container.workers.indexer.tick();
    for (let i = 0; i < 3; i++) await container.workers.payouts.tick();
    expect(status(id)).toBe('PAYOUT_PENDING');
    expect((await view(id)).payout).toEqual({ status: 'PENDING', provider: 'simulated-upi' });
    expect(near.sent.map((s) => s.kind)).toEqual(['delegate']);
  });
});

describe('UPI payments in the history', () => {
  it('lists INR and THB payments together, newest first, each in its own currency and partner', async () => {
    const { app, container, pay, session, status } = await setup();
    const upi = (await pay(chai250)).paid.json<{ id: string }>();
    await new Promise((resolve) => setTimeout(resolve, 5)); // distinct createdAt
    const thai = (await pay(thai100)).paid.json<{ id: string }>();
    await container.workers.indexer.tick();
    for (let i = 0; i < 4 && (status(upi.id) !== 'SETTLED' || status(thai.id) !== 'SETTLED'); i++) await container.workers.payouts.tick();

    const { payments } = (await app.inject({ method: 'GET', url: '/me/payments', headers: session.auth })).json();
    expect(payments.map((p: { id: string }) => p.id)).toEqual([thai.id, upi.id]);
    expect(payments[0]).toMatchObject({ status: 'SETTLED', fiatCurrency: 'THB', fiatAmount: '10000', payout: { provider: 'simulated-promptpay' } });
    expect(payments[1]).toMatchObject({
      status: 'SETTLED',
      fiatCurrency: 'INR',
      fiatAmount: '25000',
      merchant: { kind: 'upi', targetId: 'chai.stall@okaxis' },
      payout: { provider: 'simulated-upi', reference: expect.stringMatching(/^\d{12}$/) },
    });
  });
});

describe('UPI payouts: idempotency', () => {
  function upiPayment(repos: ReturnType<typeof createMemoryRepositories>) {
    const payment = seedPayment(repos, { userId: 'u1', fiatMinor: 250_00n, status: 'PAYOUT_PENDING', createdAt: new Date() });
    const stored = repos.state.quotes.get(payment.quoteId)!;
    stored.quote = { ...stored.quote, fiat: INR_250, merchant: upiMerchant, merchantRef: 'upi:chai.stall@okaxis' };
    return payment;
  }

  it('creates a UPI payout once, keyed by the payment ID, however often the tracker checks', async () => {
    let clock = 1_000_000;
    const repos = createMemoryRepositories();
    const thai = new SimulatedPromptPayProvider({ delayMs: 0, failureRate: 0 });
    const india = new SimulatedUpiProvider({ delayMs: 60_000, failureRate: 0, now: () => clock });
    const create = vi.spyOn(india, 'createPayout');
    const tracker = new PayoutTracker({
      payouts: repos.payouts,
      provider: thai,
      router: new PayoutRouter({ promptpay: thai, upi: india }),
      recheckMs: 0,
      pendingDeadlineMs: 10 * 60_000,
    });
    const payment = upiPayment(repos);
    const item = (await repos.payments.findById(payment.id))!;

    for (let i = 0; i < 4; i++) expect((await tracker.check(item)).status).toBe('PENDING');
    clock += 60_000;
    const done = await tracker.check(item);
    expect(done).toMatchObject({ provider: 'simulated-upi', status: 'SUCCEEDED' });
    expect(create).toHaveBeenCalledTimes(1);
    expect(create.mock.calls[0]?.[0]).toMatchObject({ idempotencyKey: payment.id, paymentId: payment.id, amount: INR_250 });
    // Checking a paid payout again neither pays again nor changes the UTR.
    const again = await tracker.check(item);
    expect(again.providerReference).toBe(done.providerReference);
    expect(create).toHaveBeenCalledTimes(1);
  });

  it('answers a repeated create with the same payout and UTR, and different payments with different ones', async () => {
    const provider = new SimulatedUpiProvider({ delayMs: 0, failureRate: 0 });
    const request = { idempotencyKey: 'pay-1', paymentId: 'pay-1', merchant: upiMerchant, amount: INR_250 };
    const first = (await provider.createPayout(request)) as { providerRef: string };
    const second = (await provider.createPayout(request)) as { providerRef: string };
    expect(second.providerRef).toBe(first.providerRef);
    const other = (await provider.createPayout({ ...request, idempotencyKey: 'pay-2', paymentId: 'pay-2' })) as { providerRef: string };
    expect(other.providerRef).not.toBe(first.providerRef);

    const a = (await provider.getPayout(first.providerRef)) as { reference: string };
    const b = (await provider.getPayout(other.providerRef)) as { reference: string };
    expect(a.reference).toMatch(/^\d{12}$/);
    expect(b.reference).toMatch(/^\d{12}$/);
    expect(a.reference).not.toBe(b.reference);
    await expect(provider.findByIdempotencyKey('pay-1')).resolves.toMatchObject({ status: 'succeeded', reference: a.reference });
  });

  it('gives a restarted partner the same outcome and UTR for each payment', async () => {
    const before = new SimulatedUpiProvider({ delayMs: 0, failureRate: 0.5 });
    const after = new SimulatedUpiProvider({ delayMs: 0, failureRate: 0.5 });
    const outcomes = new Set<string>();
    for (let i = 0; i < 12; i++) {
      const request = { idempotencyKey: `p${i}`, paymentId: `p${i}`, merchant: upiMerchant, amount: INR_250 };
      const ref = ((await before.createPayout(request)) as { providerRef: string }).providerRef;
      const one = await before.getPayout(ref);
      const two = await after.getPayout(ref);
      expect(two).toEqual(one);
      outcomes.add(one.status);
    }
    expect([...outcomes].sort()).toEqual(['failed', 'succeeded']);
  });

  it("treats a UPI reference it doesn't know as unknown, never failed, and finds nothing for an unknown key", async () => {
    const provider = new SimulatedUpiProvider({ delayMs: 0, failureRate: 0 });
    const result = await provider.getPayout('not-a-simulated-ref');
    expect(result.status).toBe('unknown');
    expect(result).not.toHaveProperty('reference');
    await expect(provider.findByIdempotencyKey('never-created')).resolves.toBeNull();
  });

  it('refuses a UPI merchant paid in THB, before any payout exists', async () => {
    const provider = new SimulatedUpiProvider({ delayMs: 0, failureRate: 0 });
    const result = await provider.createPayout({
      idempotencyKey: 'thb',
      paymentId: 'thb',
      merchant: upiMerchant,
      amount: { currency: 'THB', minor: 100_00n },
    });
    expect(result).toMatchObject({ status: 'failed', providerStatus: 'UNSUPPORTED' });
    await expect(provider.findByIdempotencyKey('thb')).resolves.toBeNull();
  });
});

describe('UPI payouts: webhooks', () => {
  it('has no webhook for the simulated partners: a forged success is 404 and changes nothing', async () => {
    const { app, container, pay, repos, status } = await setup({ PAYOUT_DELAY_MS: '600000' });
    const { id } = (await pay(chai250)).paid.json<{ id: string }>();
    await container.workers.indexer.tick();
    await container.workers.payouts.tick();
    const before = { ...repos.state.payouts.get(id) };
    expect(before.status).toBe('PENDING');

    for (const partner of ['simulated-upi', 'simulated-promptpay', 'xendit']) {
      const response = await app.inject({
        method: 'POST',
        url: `/webhooks/payouts/${partner}`,
        payload: { id: before.providerRef, external_id: id, status: 'SUCCEEDED' },
      });
      expect(response.statusCode, partner).toBe(404);
    }
    await container.workers.payouts.tick();
    expect(status(id)).toBe('PAYOUT_PENDING');
    expect(repos.state.payouts.get(id)).toMatchObject({ status: 'PENDING', providerRef: before.providerRef });
  });
});

describe('KYC limits across INR and THB', () => {
  it('counts THB spending in the last 24 hours against an INR quote', async () => {
    const { quote, repos, session } = await setup();
    seedPayment(repos, { userId: session.userId, fiatMinor: 19_990_00n, status: 'SETTLED', createdAt: new Date() });
    // ₹100 ≈ 1.147728 USDC ≈ 37.31 THB: over the 10.00 THB left of tier 1's 20,000 THB a day.
    const response = await quote(shop(100_00n));
    expect(response.statusCode).toBe(422);
    expect(response.json().error).toBe('daily_limit_exceeded');
    expect(response.json().message).toContain('10.00 THB remains');
  });

  it('checks an INR payment against THB spent since its quote, at POST /payments, relaying nothing', async () => {
    const { app, near, quote, repos, session } = await setup();
    const body = (await quote(shop(10_000_00n))).json<QuoteBody>(); // ≈ 3,730 THB
    seedPayment(repos, { userId: session.userId, fiatMinor: 16_500_00n, status: 'SETTLED', createdAt: new Date() });

    const signedDelegate = await signNearPayment(NEAR.payerKey, body.nearPayment);
    const response = await app.inject({ method: 'POST', url: '/payments', headers: session.auth, payload: { quoteId: body.quote.quoteId, signedDelegate } });
    expect(response.statusCode).toBe(422);
    expect(response.json().error).toBe('daily_limit_exceeded');
    expect(near.sent).toEqual([]);
    expect([...repos.state.payments.values()].filter((p) => p.quoteId === body.quote.quoteId)).toEqual([]);
  });

  it('ignores failed and refunded INR payments in the 24-hour total', async () => {
    const { quote, repos, session } = await setup();
    for (const status of ['FAILED', 'REFUNDED'] as const) {
      const payment = seedPayment(repos, { userId: session.userId, fiatMinor: 19_990_00n, status, createdAt: new Date() });
      const stored = repos.state.quotes.get(payment.quoteId)!;
      stored.quote = { ...stored.quote, fiat: { currency: 'INR', minor: 19_990_00n }, merchant: upiMerchant };
    }
    expect((await quote(shop(100_00n))).statusCode).toBe(201);
  });

  // The rolling 24-hour total (PaymentRepository.sumFiatSince, memory and Prisma) adds up quote.fiat.minor
  // whatever the currency, so ₹10,000.00 counts as 10,000.00 THB instead of its ≈3,730 THB equivalent.
  // Two ₹10,000 payments (≈7,460 THB) use up tier 1's whole 20,000 THB day.
  it.skip('BUG: counts earlier INR payments at their THB equivalent in the 24-hour total, not at face value', async () => {
    const { pay, quote } = await setup();
    expect((await pay(shop(10_000_00n))).paid.statusCode).toBe(202);
    expect((await pay(shop(10_000_00n))).paid.statusCode).toBe(202);
    // ≈7,460 THB spent: 100 THB more is well within 20,000 THB.
    const response = await quote(thai100);
    expect(response.json().error).toBeUndefined();
    expect(response.statusCode).toBe(201);
  });
});

describe('UPI quotes: the rate feed', () => {
  it('answers 503 rate_unavailable with no quote stored when the USDC/INR rate is missing, while THB still quotes', async () => {
    const { quote, repos } = await setup({}, { rates: new FixedRateProvider({ THB: RATES.THB }) });
    const response = await quote(chai250);
    expect(response.statusCode).toBe(503);
    expect(response.json().error).toBe('rate_unavailable');
    expect(repos.state.quotes.size).toBe(0);
    expect((await quote(thai100)).statusCode).toBe(201);
  });

  it('refuses POST /payments for an INR quote with 503 when the USDC/THB rate for the limits is down, relaying nothing', async () => {
    let down = false;
    const fixed = new FixedRateProvider(RATES);
    const rates: RateProvider = {
      getRate: async (base, quote) => {
        if (down) throw new AppError('rate_unavailable', 'Exchange rate unavailable', 503);
        return fixed.getRate(base, quote);
      },
    };
    const { app, near, quote, repos, session } = await setup({}, { rates });
    const body = (await quote(chai250)).json<QuoteBody>();
    down = true;

    const signedDelegate = await signNearPayment(NEAR.payerKey, body.nearPayment);
    const response = await app.inject({ method: 'POST', url: '/payments', headers: session.auth, payload: { quoteId: body.quote.quoteId, signedDelegate } });
    expect(response.statusCode).toBe(503);
    expect(response.json().error).toBe('rate_unavailable');
    expect(near.sent).toEqual([]);
    expect(repos.state.payments.size).toBe(0);

    // Back up: the same quote and delegate go through.
    down = false;
    const retry = await app.inject({ method: 'POST', url: '/payments', headers: session.auth, payload: { quoteId: body.quote.quoteId, signedDelegate } });
    expect(retry.statusCode).toBe(202);
  });
});

describe('UPI quotes: the payout float', () => {
  it("refuses THB quotes on a low PromptPay float but not UPI quotes (the UPI partner reports none)", async () => {
    const low = new SimulatedPromptPayProvider({ delayMs: 0, failureRate: 0, float: { currency: 'THB', minor: 150_00n } });
    const { quote } = await setup({ PAYOUT_FLOAT_BUFFER_THB: '100' }, { payouts: low });
    const thai = await quote(thai100);
    expect(thai.statusCode).toBe(503);
    expect(thai.json().error).toBe('payouts_unavailable');
    expect((await quote(chai250)).statusCode).toBe(201);
  });

  it("refuses a UPI quote when the UPI partner's float can't be read, storing nothing", async () => {
    const upi = new SimulatedUpiProvider({ delayMs: 0, failureRate: 0 });
    upi.getBalance = async () => {
      throw new Error('ECONNRESET');
    };
    const { quote, repos } = await setup({}, { upiPayouts: upi });
    const response = await quote(chai250);
    expect(response.statusCode).toBe(503);
    expect(response.json().error).toBe('payouts_unavailable');
    expect(repos.state.quotes.size).toBe(0);
  });

  it('checks a UPI float in INR to the paisa, with no THB buffer, and refuses a float in another currency', async () => {
    const upi = new SimulatedUpiProvider({ delayMs: 0, failureRate: 0 });
    const { quote } = await setup({ PAYOUT_FLOAT_BUFFER_THB: '100000' }, { upiPayouts: upi });

    upi.getBalance = async () => ({ currency: 'INR', minor: 250_00n });
    expect((await quote(chai250)).statusCode).toBe(201);
    upi.getBalance = async () => ({ currency: 'INR', minor: 249_99n });
    expect((await quote(chai250)).json().error).toBe('payouts_unavailable');
    upi.getBalance = async () => ({ currency: 'THB', minor: 1_000_000_00n });
    expect((await quote(chai250)).json().error).toBe('payouts_unavailable');
  });
});
