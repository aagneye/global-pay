import { afterEach, describe, expect, it } from 'vitest';
import { SimulatedPromptPayProvider } from '../src/adapters/payouts/simulated-promptpay-provider.js';
import { XenditPayoutProvider } from '../src/adapters/payouts/xendit-provider.js';
import type { Adapters } from '../src/container.js';
import { buildPromptPayQr } from '../src/lib/promptpay/build.js';
import { ANVIL } from './support/anvil.js';
import { type TestApp, buildTestApp, createQuote, signAuthorization, signInVerified, submitPayment } from './support/app.js';

const PAYER_KEY = ANVIL.accounts.payer.privateKey;
const BILLER = '099999999999901';
const billerQr = buildPromptPayQr({
  kind: 'merchant',
  targetType: 'biller',
  targetId: BILLER,
  amount: { currency: 'THB', minor: 100_00n },
});
const otherBillerQr = buildPromptPayQr({
  kind: 'merchant',
  targetType: 'biller',
  targetId: '010555555555501',
  amount: { currency: 'THB', minor: 100_00n },
});

let testApp: TestApp | undefined;
afterEach(async () => {
  await testApp?.app.close();
  testApp = undefined;
});

async function setup(adapters: Partial<Adapters>, env: Record<string, string> = {}) {
  testApp = await buildTestApp({ env: { INDEXER_CONFIRMATIONS: '0', ...env }, adapters });
  const session = await signInVerified(testApp.app, PAYER_KEY);
  const quote = (qrPayload: string) =>
    testApp!.app.inject({ method: 'POST', url: '/quotes', headers: session.auth, payload: { payer: session.address, qrPayload } });
  return { ...testApp, session, quote };
}

/** A sandbox Xendit that pays our test biller; each payout's status is set by the test. */
function fakeXendit() {
  const state = { status: 'ACCEPTED', creates: 0, balance: 10_000 };
  const respond = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
  const fetch: typeof globalThis.fetch = async (url, init) => {
    const path = String(url).replace('https://api.xendit.co', '');
    const payout = () => ({ id: 'disb-1', reference_id: 'pending', status: state.status, processor_reference: 'BANK-42' });
    if (path.startsWith('/balance')) return respond({ balance: state.balance });
    if (path.startsWith('/v2/payouts?reference_id=')) return respond(state.creates ? [payout()] : []);
    if (path === '/v2/payouts' && init?.method === 'POST') {
      state.creates++;
      return respond(payout());
    }
    if (path === '/v2/payouts/disb-1') return respond(payout());
    return respond({ error_code: 'NOT_FOUND' }, 404);
  };
  const provider = new XenditPayoutProvider({
    secretKey: 'xnd_development_test',
    callbackToken: 'cb-token',
    testDestinations: { [BILLER]: { channelCode: 'TH_KBANK', accountNumber: '1234567890', accountHolderName: 'Test Cafe' } },
    fetch,
  });
  return { provider, state };
}

describe('quote guards', () => {
  it("refuses a QR the payout rail can't pay, before any money moves", async () => {
    const { provider } = fakeXendit();
    const { quote } = await setup({ payouts: provider });
    expect((await quote(billerQr)).statusCode).toBe(201);

    const refused = await quote(otherBillerQr);
    expect(refused.statusCode).toBe(422);
    expect(refused.json().error).toBe('merchant_not_supported');
  });

  it('refuses quotes when the payout float would drop below the buffer', async () => {
    const low = new SimulatedPromptPayProvider({ delayMs: 0, failureRate: 0, float: { currency: 'THB', minor: 150_00n } });
    const { quote } = await setup({ payouts: low }, { PAYOUT_FLOAT_BUFFER_THB: '100' });
    const refused = await quote(billerQr);
    expect(refused.statusCode).toBe(503);
    expect(refused.json().error).toBe('payouts_unavailable');
  });

  it('accepts quotes the float covers', async () => {
    const enough = new SimulatedPromptPayProvider({ delayMs: 0, failureRate: 0, float: { currency: 'THB', minor: 500_00n } });
    const { quote } = await setup({ payouts: enough }, { PAYOUT_FLOAT_BUFFER_THB: '100' });
    expect((await quote(billerQr)).statusCode).toBe(201);
  });

  it("refuses quotes when the float can't be read", async () => {
    const down = new SimulatedPromptPayProvider({ delayMs: 0, failureRate: 0 });
    down.getBalance = async () => {
      throw new Error('ECONNRESET');
    };
    const { quote } = await setup({ payouts: down });
    expect((await quote(billerQr)).json().error).toBe('payouts_unavailable');
  });
});

describe('POST /webhooks/payouts/:partner', () => {
  async function paidWithXendit() {
    const xendit = fakeXendit();
    const ctx = await setup({ payouts: xendit.provider });
    const quote = await createQuote(ctx.app, ctx.session, billerQr);
    const submitted = await submitPayment(ctx.app, ctx.session, quote, await signAuthorization(PAYER_KEY, quote));
    const id: string = submitted.json().id;
    await ctx.container.workers.indexer.tick();
    await ctx.container.workers.payouts.tick(); // creates the Xendit payout
    const webhook = (headers: Record<string, string>, partner = 'xendit') =>
      ctx.app.inject({
        method: 'POST',
        url: `/webhooks/payouts/${partner}`,
        headers,
        payload: { event: 'payout.succeeded', data: { id: 'disb-1', reference_id: id, status: 'SUCCEEDED' } },
      });
    return { ...ctx, ...xendit, id, webhook };
  }

  it('re-fetches the payout, then settles once the partner confirms', async () => {
    const { id, repos, state, webhook, container } = await paidWithXendit();
    expect(repos.state.payouts.get(id)).toMatchObject({ status: 'PENDING', providerRef: 'disb-1' });

    // The webhook claims success, but Xendit still says ACCEPTED: nothing changes.
    expect((await webhook({ 'x-callback-token': 'cb-token' })).statusCode).toBe(200);
    expect(repos.state.payouts.get(id)?.status).toBe('PENDING');

    state.status = 'SUCCEEDED';
    expect((await webhook({ 'x-callback-token': 'cb-token' })).statusCode).toBe(200);
    expect(repos.state.payouts.get(id)).toMatchObject({ status: 'SUCCEEDED', providerReference: 'BANK-42' });
    expect(repos.state.payoutEvents.filter((e) => e.source === 'webhook')).toHaveLength(4);

    await container.workers.payouts.tick();
    expect(repos.state.payments.get(id)?.status).toBe('SETTLED');
    expect(state.creates).toBe(1);
  });

  it('rejects a webhook without the right token', async () => {
    const { id, repos, state, webhook } = await paidWithXendit();
    state.status = 'SUCCEEDED';
    expect((await webhook({ 'x-callback-token': 'nope' })).statusCode).toBe(401);
    expect((await webhook({})).statusCode).toBe(401);
    expect(repos.state.payouts.get(id)?.status).toBe('PENDING');
  });

  it('has no webhook for a partner that is not active', async () => {
    const { webhook } = await paidWithXendit();
    expect((await webhook({ 'x-callback-token': 'cb-token' }, 'stripe')).statusCode).toBe(404);

    const simulated = await buildTestApp();
    const response = await simulated.app.inject({ method: 'POST', url: '/webhooks/payouts/simulated-promptpay', payload: {} });
    expect(response.statusCode).toBe(404);
    await simulated.app.close();
  });
});
