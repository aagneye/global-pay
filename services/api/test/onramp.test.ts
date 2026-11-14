import { createHmac } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { MoonPayOnrampProvider } from '../src/adapters/onramp/moonpay-provider.js';
import type { Adapters } from '../src/container.js';
import { generatePrivateKey } from 'viem/accounts';
import { ANVIL } from './support/anvil.js';
import { type TestApp, buildTestApp, signIn } from './support/app.js';

const PAYER_KEY = ANVIL.accounts.payer.privateKey;
const WALLET = ANVIL.accounts.payer.address;

let testApp: TestApp | undefined;
afterEach(async () => {
  await testApp?.app.close();
  testApp = undefined;
});

async function setup(env: Record<string, string> = {}, adapters: Partial<Adapters> = {}) {
  testApp = await buildTestApp({ env: { INDEXER_CONFIRMATIONS: '0', ...env }, adapters });
  const session = await signIn(testApp.app, PAYER_KEY);
  const order = (fiatAmountMinor: string, auth = session.auth) =>
    testApp!.app.inject({ method: 'POST', url: '/onramp/orders', headers: auth, payload: { fiatAmountMinor } });
  const get = (id: string, auth = session.auth) => testApp!.app.inject({ method: 'GET', url: `/onramp/orders/${id}`, headers: auth });
  return { ...testApp, session, order, get };
}

describe('POST /onramp/orders', () => {
  it('refuses amounts outside the limits, too many open orders, and anonymous users', async () => {
    const { order, app } = await setup({ ONRAMP_MAX_OPEN_ORDERS: '2' });
    expect((await order('79999')).json().error).toBe('amount_too_small');
    expect((await order('5000001')).json().error).toBe('amount_too_large');
    expect((await order('80000')).statusCode).toBe(201);
    expect((await order('80000')).statusCode).toBe(201);
    const third = await order('80000');
    expect(third.statusCode).toBe(429);
    expect(third.json().error).toBe('too_many_orders');
    expect((await app.inject({ method: 'POST', url: '/onramp/orders', payload: { fiatAmountMinor: '80000' } })).statusCode).toBe(401);
  });

  it("keeps each user's orders to themselves", async () => {
    const { order, get, app } = await setup();
    const { order: created } = (await order('80000')).json();
    const other = await signIn(app, generatePrivateKey());
    expect((await get(created.id, other.auth)).statusCode).toBe(404);
  });
});

describe('Add money with the simulated onramp', () => {
  it('pays on the checkout page, proves the USDC on-chain, and shows the deposit', async () => {
    const { order, get, app, session, container } = await setup();
    const created = await order('80000');
    expect(created.statusCode).toBe(201);
    const { order: placed, checkoutUrl } = created.json();
    expect(placed).toMatchObject({ status: 'CREATED', provider: 'simulated-onramp', fiatCurrency: 'THB', fiatAmount: '80000' });
    expect(checkoutUrl).toBe(`/onramp/simulator/${placed.id}`);

    const page = await app.inject({ method: 'GET', url: checkoutUrl });
    expect(page.statusCode).toBe(200);
    expect(page.headers['content-security-policy']).toContain("default-src 'none'");
    expect(page.body).toContain('800.00 THB');
    expect(page.body).toContain(WALLET);

    const paid = await app.inject({ method: 'POST', url: `${checkoutUrl}/pay`, headers: { 'content-type': 'application/x-www-form-urlencoded' }, payload: '' });
    expect(paid.statusCode).toBe(303);
    expect((await app.inject({ method: 'GET', url: checkoutUrl })).body).toContain('Paid');

    // 800 THB at 32.50 THB/USDC = 24.615384 USDC, proved on the (fake) chain.
    const done = (await get(placed.id)).json();
    expect(done).toMatchObject({ status: 'COMPLETED', tokenAmount: '24615384', transaction: { hash: expect.stringMatching(/^0x/) } });
    expect(done.transaction.url).toMatch(/\/tx\/0x/);

    await container.workers.deposits.tick();
    const deposits = (await app.inject({ method: 'GET', url: '/me/deposits', headers: session.auth })).json().deposits;
    expect(deposits).toEqual([
      expect.objectContaining({ amount: '24615384', onrampOrderId: placed.id, transaction: expect.objectContaining({ hash: done.transaction.hash }) }),
    ]);
    const list = (await app.inject({ method: 'GET', url: '/onramp/orders', headers: session.auth })).json().orders;
    expect(list.map((o: { id: string }) => o.id)).toEqual([placed.id]);
  });

  it('fails the order when the card is declined', async () => {
    const { order, get, app } = await setup();
    const { order: placed, checkoutUrl } = (await order('100000')).json();
    await app.inject({ method: 'POST', url: `${checkoutUrl}/decline`, headers: { 'content-type': 'application/x-www-form-urlencoded' }, payload: '' });
    expect((await get(placed.id)).json()).toMatchObject({ status: 'FAILED', failureReason: 'Card declined (simulated)' });
  });

  it('has no checkout page with a real partner', async () => {
    const { app } = await setup({}, { onramp: moonpayWith(async () => new Response('[]')) });
    expect((await app.inject({ method: 'GET', url: '/onramp/simulator/order_1' })).statusCode).toBe(404);
  });
});

/** MoonPay with a canned API. */
function moonpayWith(respond: (url: string) => Promise<Response>) {
  return new MoonPayOnrampProvider({
    publishableKey: 'pk_test_abc',
    secretKey: 'sk_test_secret',
    webhookKey: 'wk_test_hook',
    fetch: async (url) => respond(String(url)),
  });
}

/** Signs a raw body the way MoonPay does. */
function sign(raw: string, key = 'wk_test_hook', at = new Date()) {
  const t = Math.floor(at.getTime() / 1000);
  return `t=${t},s=${createHmac('sha256', key).update(`${t}.${raw}`).digest('hex')}`;
}

describe('POST /webhooks/onramp/:partner', () => {
  async function moonpaySetup() {
    let purchase: Record<string, unknown> | undefined;
    const ctx = await setup({}, { onramp: moonpayWith(async () => new Response(JSON.stringify(purchase ? [purchase] : []))) });
    const { order: placed, checkoutUrl } = (await ctx.order('80000')).json();
    const webhook = (raw: string, signature: string, partner = 'moonpay') =>
      ctx.app.inject({
        method: 'POST',
        url: `/webhooks/onramp/${partner}`,
        headers: { 'content-type': 'application/json', 'moonpay-signature-v2': signature },
        payload: raw,
      });
    return { ...ctx, placed, checkoutUrl, webhook, setPurchase: (p: Record<string, unknown>) => (purchase = p) };
  }

  it('checks the signature over the raw body, re-fetches the purchase, then completes on-chain', async () => {
    const { placed, checkoutUrl, webhook, setPurchase, get, tokens, env } = await moonpaySetup();
    expect(checkoutUrl).toMatch(/^https:\/\/buy-sandbox\.moonpay\.com\?apiKey=pk_test_abc&.*&signature=/);

    const hash = tokens.send(env.USDC_ADDRESS, [{ to: WALLET, value: 24_500_000n }]);
    setPurchase({ id: 'mp_1', status: 'completed', walletAddress: WALLET, quoteCurrencyAmount: 24.5, cryptoTransactionId: hash, externalTransactionId: placed.id });

    // Whitespace matters: the signature covers the exact bytes.
    const raw = `{ "type": "transaction_updated",  "data": { "externalTransactionId": "${placed.id}", "status": "completed" } }`;
    const response = await webhook(raw, sign(raw));
    expect(response.statusCode).toBe(200);
    expect((await get(placed.id)).json()).toMatchObject({ status: 'COMPLETED', tokenAmount: '24500000' });
  });

  it('refuses a bad or replayed signature, and a partner that is not active', async () => {
    const { placed, webhook } = await moonpaySetup();
    const raw = JSON.stringify({ data: { externalTransactionId: placed.id } });
    expect((await webhook(raw, sign(raw, 'wrong-key'))).statusCode).toBe(401);
    expect((await webhook(raw, sign(raw, undefined, new Date(Date.now() - 10 * 60_000)))).statusCode).toBe(401);
    expect((await webhook(`${raw} `, sign(raw))).statusCode).toBe(401);
    expect((await webhook(raw, sign(raw), 'stripe')).statusCode).toBe(404);
  });

  it("answers 200 for an authentic webhook about an order it doesn't know", async () => {
    const { webhook } = await moonpaySetup();
    const raw = JSON.stringify({ data: { externalTransactionId: 'someone-elses-order' } });
    expect((await webhook(raw, sign(raw))).statusCode).toBe(200);
  });
});
