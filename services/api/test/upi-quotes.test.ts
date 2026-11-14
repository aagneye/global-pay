import { afterEach, describe, expect, it, vi } from 'vitest';
import { FixedRateProvider } from '../src/adapters/rates/fixed-rate-provider.js';
import { buildUpiQr } from '../src/lib/upi/build.js';
import { limitAmountThb } from '../src/modules/kyc/limits.js';
import { ANVIL } from './support/anvil.js';
import { type TestApp, buildTestApp, createQuote, signInVerified } from './support/app.js';
import { FakeNearGateway, RecordingOnboarding } from './support/fake-near.js';
import { NEAR, type NearPaymentJson, implicitAccount, nearEnv, nearSignIn, signNearPayment } from './support/near.js';

const PAYER = implicitAccount(NEAR.payerKey);
const chai250 = buildUpiQr({ vpa: 'chai.stall@okaxis', name: 'Ravi Chai', amountMinor: 250_00n, merchantCode: '5812', reference: 'ORD-42' });
const staticPersonal = buildUpiQr({ vpa: 'ravi-01@ybl', name: 'Ravi Kumar' });

vi.setConfig({ testTimeout: 30_000 });

let testApp: TestApp | undefined;

afterEach(async () => {
  await testApp?.app.close();
  testApp = undefined;
});

interface QuoteBody {
  quote: { quoteId: string; tokenAmount: string; fiatCurrency: string; fiatAmount: string; merchantRefHash: string };
  pricing: { rateE8: string };
  merchant: Record<string, string>;
  nearPayment: NearPaymentJson;
}

async function setup(env: Record<string, string> = {}) {
  const near = new FakeNearGateway();
  near.setAccessKey(PAYER, NEAR.payerKey.getPublicKey().toString(), 41n);
  testApp = await buildTestApp({
    env: nearEnv({ PAYOUT_DELAY_MS: '0', PAYOUT_FAILURE_RATE: '0', ...env }),
    adapters: { nearGateway: near, nearOnboarding: new RecordingOnboarding() },
  });
  const { app, container, repos } = testApp;
  const session = await nearSignIn(app);
  await app.inject({ method: 'POST', url: '/kyc/start', headers: session.auth });
  await app.inject({ method: 'GET', url: '/kyc/status', headers: session.auth });
  const quote = (qrPayload: string, fiatAmountMinor?: string) =>
    app.inject({
      method: 'POST',
      url: '/quotes',
      headers: session.auth,
      payload: { payer: PAYER, qrPayload, ...(fiatAmountMinor ? { fiatAmountMinor } : {}) },
    });
  return { app, container, repos, near, session, quote };
}

describe('limitAmountThb', () => {
  it('counts an INR payment against the KYC limits at its THB equivalent, rounded up', async () => {
    const rates = new FixedRateProvider({ THB: 32_50000000n, INR: 88_00000000n });
    // 2.869319 USDC × 32.50 THB = 93.25286… THB → 93.26 THB
    await expect(limitAmountThb(rates, { currency: 'INR', minor: 250_00n }, 2_869_319n)).resolves.toBe(93_26n);
    await expect(limitAmountThb(rates, { currency: 'THB', minor: 100_00n }, 3_107_693n)).resolves.toBe(100_00n);
  });
});

describe('UPI QR quotes (NEAR rail)', () => {
  it('quotes a dynamic UPI merchant QR in INR at USDC/INR', async () => {
    const { quote } = await setup();
    const response = await quote(chai250);
    expect(response.statusCode).toBe(201);
    const body = response.json<QuoteBody>();
    // ₹250.00 at 88.00 INR/USDC + 1% = 2.869319 USDC
    expect(body.quote).toMatchObject({ fiatCurrency: 'INR', fiatAmount: '25000', tokenAmount: '2869319' });
    expect(body.pricing.rateE8).toBe('8800000000');
    expect(body.merchant).toEqual({
      kind: 'merchant',
      targetType: 'vpa',
      targetId: 'chai.stall@okaxis',
      merchantName: 'Ravi Chai',
      reference1: 'ORD-42',
    });
    // The contract reads the quote JSON in the NEAR msg: INR goes on-chain as the fiat currency.
    const signed = JSON.parse(JSON.parse(body.nearPayment.args.msg).quote);
    expect(signed).toMatchObject({ fiat_currency: 'INR', fiat_amount: '25000', token_amount: '2869319' });
  });

  it('takes the amount for a static QR, and treats a QR without mc as personal', async () => {
    const { quote } = await setup();
    expect((await quote(staticPersonal)).json()).toMatchObject({ error: 'amount_required' });
    const response = await quote(staticPersonal, '9900');
    expect(response.statusCode).toBe(201);
    expect(response.json<QuoteBody>().merchant).toMatchObject({ kind: 'personal', targetType: 'vpa', targetId: 'ravi-01@ybl' });
    expect((await quote(chai250, '100')).json()).toMatchObject({ error: 'amount_mismatch' });
  });

  it('refuses personal UPI QRs when MERCHANT_QR_ONLY is on', async () => {
    const { quote } = await setup({ MERCHANT_QR_ONLY: 'true' });
    expect((await quote(staticPersonal, '9900')).json()).toMatchObject({ error: 'personal_qr_not_allowed' });
    expect((await quote(chai250)).statusCode).toBe(201);
  });

  it('refuses other currencies and bad VPAs', async () => {
    const { quote } = await setup();
    const usd = await quote('upi://pay?pa=chai.stall@okaxis&am=10.00&cu=USD&mc=5812');
    expect(usd.statusCode).toBe(422);
    expect(usd.json()).toMatchObject({ error: 'currency_not_supported' });
    expect((await quote('upi://pay?pa=nobody&am=10.00&mc=5812')).json()).toMatchObject({ error: 'invalid_qr' });
  });

  it('checks the KYC limits at the THB equivalent', async () => {
    const { quote } = await setup();
    // ₹10,000 ≈ 114.78 USDC ≈ 3,730 THB: within tier 1's 5,000 THB per payment (10,000.00 counted as THB would not be).
    expect((await quote(buildUpiQr({ vpa: 'shop@okaxis', amountMinor: 10_000_00n, merchantCode: '5411' }))).statusCode).toBe(201);
    // ₹15,000 ≈ 5,596 THB: over it.
    const over = await quote(buildUpiQr({ vpa: 'shop@okaxis', amountMinor: 15_000_00n, merchantCode: '5411' }));
    expect(over.json()).toMatchObject({ error: 'payment_limit_exceeded' });
  });

  it('pays, pays the merchant over UPI with a UTR, and settles', async () => {
    const { app, container, repos, near, session, quote } = await setup();
    const body = (await quote(chai250)).json<QuoteBody>();
    const signedDelegate = await signNearPayment(NEAR.payerKey, body.nearPayment);
    const paid = await app.inject({ method: 'POST', url: '/payments', headers: session.auth, payload: { quoteId: body.quote.quoteId, signedDelegate } });
    expect(paid.statusCode).toBe(202);
    const { id } = paid.json<{ id: string }>();

    await container.workers.indexer.tick();
    for (let i = 0; i < 4 && repos.state.payments.get(id)?.status !== 'SETTLED'; i++) await container.workers.payouts.tick();
    expect(repos.state.payments.get(id)?.status).toBe('SETTLED');
    expect(near.sent.map((s) => s.kind)).toEqual(['delegate', 'settle']);

    const view = (await app.inject({ method: 'GET', url: `/payments/${id}`, headers: session.auth })).json();
    expect(view).toMatchObject({
      status: 'SETTLED',
      fiatCurrency: 'INR',
      fiatAmount: '25000',
      merchant: { kind: 'upi', targetId: 'chai.stall@okaxis', name: 'Ravi Chai' },
      payout: { status: 'SUCCEEDED', provider: 'simulated-upi' },
    });
    expect(view.payout.reference).toMatch(/^\d{12}$/);
  });

  it('refunds when the UPI payout fails', async () => {
    const { app, container, repos, near, session, quote } = await setup({ PAYOUT_FAILURE_RATE: '1' });
    const body = (await quote(chai250)).json<QuoteBody>();
    const signedDelegate = await signNearPayment(NEAR.payerKey, body.nearPayment);
    const { id } = (
      await app.inject({ method: 'POST', url: '/payments', headers: session.auth, payload: { quoteId: body.quote.quoteId, signedDelegate } })
    ).json<{ id: string }>();
    await container.workers.indexer.tick();
    for (let i = 0; i < 4 && repos.state.payments.get(id)?.status !== 'REFUNDED'; i++) await container.workers.payouts.tick();
    expect(repos.state.payments.get(id)?.status).toBe('REFUNDED');
    expect(near.sent.map((s) => s.kind)).toEqual(['delegate', 'refund']);
  });
});

describe('UPI QR quotes (EVM rail)', () => {
  it('quotes in INR there too', async () => {
    testApp = await buildTestApp();
    const session = await signInVerified(testApp.app, ANVIL.accounts.payer.privateKey);
    const body = (await createQuote(testApp.app, session, chai250)) as unknown as QuoteBody;
    expect(body.quote).toMatchObject({ fiatCurrency: 'INR', fiatAmount: '25000', tokenAmount: '2869319' });
    expect(body.merchant).toMatchObject({ kind: 'merchant', targetType: 'vpa', targetId: 'chai.stall@okaxis' });
  });
});
