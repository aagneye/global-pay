import type { Hex } from 'viem';
import { generatePrivateKey } from 'viem/accounts';
import { afterEach, describe, expect, it } from 'vitest';
import { buildPromptPayQr } from '../src/lib/promptpay/build.js';
import { ChainUnavailableError, TransactionRejectedError } from '../src/ports/settlement-gateway.js';
import { ANVIL } from './support/anvil.js';
import {
  type TestApp,
  buildTestApp,
  createQuote,
  signAuthorization,
  signInVerified,
  submitPayment,
} from './support/app.js';
import { seedPayment } from './support/memory-repositories.js';

const PAYER_KEY = ANVIL.accounts.payer.privateKey;
const qr = buildPromptPayQr({
  kind: 'merchant',
  targetType: 'biller',
  targetId: '099999999999901',
  amount: { currency: 'THB', minor: 250_00n },
  merchantName: 'GLOBALPAY TEST CAFE',
});

let testApp: TestApp | undefined;

afterEach(async () => {
  await testApp?.app.close();
  testApp = undefined;
});

async function setup() {
  testApp = await buildTestApp({ env: { EXPLORER_URL: 'https://explorer.test' } });
  const session = await signInVerified(testApp.app, PAYER_KEY);
  const quote = await createQuote(testApp.app, session, qr);
  return { ...testApp, session, quote };
}

describe('POST /payments', () => {
  it('relays pay() and returns the payment as SUBMITTED', async () => {
    const { app, chain, session, quote } = await setup();

    const response = await submitPayment(app, session, quote, await signAuthorization(PAYER_KEY, quote));

    expect(response.statusCode).toBe(202);
    const payment = response.json();
    const [sent] = chain.sent;
    expect(sent).toMatchObject({ functionName: 'pay', quoteId: quote.quote.quoteId });
    expect(payment).toMatchObject({
      quoteId: quote.quote.quoteId,
      status: 'SUBMITTED',
      fiatCurrency: 'THB',
      fiatAmount: '25000',
      tokenAmount: quote.quote.tokenAmount,
      merchant: { kind: 'merchant', targetId: '099999999999901', name: 'GLOBALPAY TEST CAFE' },
      transactions: { pay: { hash: sent?.hash, url: `https://explorer.test/tx/${sent?.hash}` } },
    });

    const fetched = await app.inject({ method: 'GET', url: `/payments/${payment.id}`, headers: session.auth });
    expect(fetched.json()).toEqual(payment);
    const history = await app.inject({ method: 'GET', url: '/me/payments', headers: session.auth });
    expect(history.json().payments).toEqual([payment]);
  });

  it('returns the same payment when a quote is submitted twice', async () => {
    const { app, chain, session, quote } = await setup();
    const signature = await signAuthorization(PAYER_KEY, quote);

    const first = await submitPayment(app, session, quote, signature);
    const second = await submitPayment(app, session, quote, signature);

    expect(second.json().id).toBe(first.json().id);
    expect(chain.sent).toHaveLength(1);
  });

  it("refuses a signature that isn't the payer's, or that changes the terms", async () => {
    const { app, chain, repos, session, quote } = await setup();

    const stranger = await submitPayment(app, session, quote, await signAuthorization(generatePrivateKey(), quote));
    expect(stranger.statusCode).toBe(422);
    expect(stranger.json().error).toBe('invalid_authorization');

    const changed = await submitPayment(app, session, quote, await signAuthorization(PAYER_KEY, quote), {
      validBefore: String(quote.quote.expiresAt + 3600),
    });
    expect(changed.json().error).toBe('invalid_authorization');

    expect(chain.sent).toHaveLength(0);
    expect(repos.state.payments.size).toBe(0);
  });

  it("returns 404 for another user's quote or payment", async () => {
    const { app, session, quote } = await setup();
    const signature = await signAuthorization(PAYER_KEY, quote);
    const other = await signInVerified(app, generatePrivateKey());

    const submit = await submitPayment(app, other, quote, signature);
    expect(submit.statusCode).toBe(404);
    expect(submit.json().error).toBe('quote_not_found');

    const { id } = (await submitPayment(app, session, quote, signature)).json();
    const peek = await app.inject({ method: 'GET', url: `/payments/${id}`, headers: other.auth });
    expect(peek.statusCode).toBe(404);
  });

  it('refuses an expired quote without sending anything', async () => {
    const { app, chain, repos, session, quote } = await setup();
    const stored = repos.state.quotes.get(quote.quote.quoteId);
    if (stored) stored.quote.expiresAt = new Date(Date.now() - 1_000);

    const response = await submitPayment(app, session, quote, await signAuthorization(PAYER_KEY, quote));
    expect(response.statusCode).toBe(422);
    expect(response.json().error).toBe('quote_expired');
    expect(chain.sent).toHaveLength(0);
  });

  it('checks the spending limits again at submission', async () => {
    const { app, repos, session, quote } = await setup();
    seedPayment(repos, { userId: session.userId, fiatMinor: 19_900_00n, status: 'SETTLED', createdAt: new Date() });

    const response = await submitPayment(app, session, quote, await signAuthorization(PAYER_KEY, quote));
    expect(response.statusCode).toBe(422);
    expect(response.json().error).toBe('daily_limit_exceeded');
  });

  it('fails the payment when the contract would reject it', async () => {
    const { app, chain, session, quote } = await setup();
    chain.failNextWrite = new TransactionRejectedError('ERC20InsufficientBalance');

    const response = await submitPayment(app, session, quote, await signAuthorization(PAYER_KEY, quote));
    expect(response.statusCode).toBe(422);
    expect(response.json()).toMatchObject({
      error: 'payment_rejected',
      message: 'The payment would fail on-chain: ERC20InsufficientBalance',
    });

    const [payment] = (await app.inject({ method: 'GET', url: '/me/payments', headers: session.auth })).json().payments;
    expect(payment).toMatchObject({ status: 'FAILED', failureReason: 'ERC20InsufficientBalance' });
  });

  it('keeps the payment SUBMITTED when a signed transaction may have been sent', async () => {
    const { app, chain, session, quote } = await setup();
    const hash: Hex = `0x${'12'.repeat(32)}`;
    chain.failNextWrite = new ChainUnavailableError('timed out', hash);

    const response = await submitPayment(app, session, quote, await signAuthorization(PAYER_KEY, quote));
    expect(response.statusCode).toBe(202);
    expect(response.json()).toMatchObject({ status: 'SUBMITTED', transactions: { pay: { hash } } });
  });

  it('fails the payment when the chain is unreachable before anything is signed', async () => {
    const { app, chain, session, quote } = await setup();
    chain.failNextWrite = new ChainUnavailableError('connection refused');

    const response = await submitPayment(app, session, quote, await signAuthorization(PAYER_KEY, quote));
    expect(response.statusCode).toBe(503);
    expect(response.json().error).toBe('chain_unavailable');
    const [payment] = (await app.inject({ method: 'GET', url: '/me/payments', headers: session.auth })).json().payments;
    expect(payment.status).toBe('FAILED');
  });

  it('validates the body', async () => {
    const { app, session, quote } = await setup();
    const response = await submitPayment(app, session, quote, '0x1234', { validAfter: '-1' });
    expect(response.statusCode).toBe(400);
  });
});

describe('GET /me/balance', () => {
  it("reads the wallet's USDC balance from the chain", async () => {
    testApp = await buildTestApp();
    const session = await signInVerified(testApp.app, PAYER_KEY);
    testApp.chain.balances.set(ANVIL.accounts.payer.address.toLowerCase(), 12_345_678n);

    const response = await testApp.app.inject({ method: 'GET', url: '/me/balance', headers: session.auth });
    expect(response.json()).toEqual({ token: ANVIL.usdc, units: '12345678', decimals: 6 });
  });
});
