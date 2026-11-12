import type { FastifyInstance } from 'fastify';
import { type Address, type Hex, recoverTypedDataAddress } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { afterEach, describe, expect, it } from 'vitest';
import { buildPromptPayQr } from '../src/lib/promptpay/build.js';
import { QUOTE_TYPES, SETTLEMENT_DOMAIN } from '../src/lib/typed-data.js';
import { AppError } from '../src/shared/errors.js';
import { ANVIL } from './support/anvil.js';
import { type TestApp, buildTestApp, signIn, signInVerified } from './support/app.js';

const cafe = {
  kind: 'merchant',
  targetType: 'biller',
  targetId: '099999999999901',
  reference1: 'INV0001',
  merchantName: 'GLOBALPAY TEST CAFE',
  merchantCity: 'BANGKOK',
} as const;
const qr250 = buildPromptPayQr({ ...cafe, amount: { currency: 'THB', minor: 250_00n } });
const qrStatic = buildPromptPayQr(cafe);
const qrPersonal = buildPromptPayQr({
  kind: 'personal',
  targetType: 'mobile',
  targetId: '0066812345678',
  amount: { currency: 'THB', minor: 50_00n },
});

interface QuoteJson {
  quote: {
    quoteId: Hex;
    payer: Address;
    token: Address;
    tokenAmount: string;
    fiatCurrency: 'THB';
    fiatAmount: string;
    merchantRefHash: Hex;
    expiresAt: number;
  };
  signature: Hex;
  expiresAt: string;
  pricing: Record<string, string | number>;
  merchant: Record<string, string>;
  authorizationToSign: {
    types: Record<string, { name: string; type: string }[]>;
    primaryType: 'ReceiveWithAuthorization';
    domain: { name: string; version: string; chainId: number; verifyingContract: Address };
    message: Record<string, string>;
  };
}

let testApp: TestApp | undefined;

afterEach(async () => {
  await testApp?.app.close();
  testApp = undefined;
});

async function setup(env: Record<string, string> = {}, adapters: Parameters<typeof buildTestApp>[0] = {}) {
  testApp = await buildTestApp({ ...adapters, env: { ...adapters.env, ...env } });
  const session = await signInVerified(testApp.app, ANVIL.accounts.payer.privateKey);
  return { ...testApp, session };
}

function postQuote(app: FastifyInstance, headers: Record<string, string>, payload: Record<string, unknown>) {
  return app.inject({ method: 'POST', url: '/quotes', headers, payload });
}

describe('POST /quotes', () => {
  it('returns a signed quote for a dynamic merchant QR', async () => {
    const { app, repos, session } = await setup();
    const before = Math.floor(Date.now() / 1000);

    const response = await postQuote(app, session.auth, { payer: session.address, qrPayload: qr250 });

    expect(response.statusCode).toBe(201);
    const body = response.json<QuoteJson>();
    const { quote } = body;

    // 250.00 THB at 32.50 THB/USDC = 7.692308 USDC (rounded up); plus 1% = 7.769231
    expect(quote).toMatchObject({
      payer: ANVIL.accounts.payer.address,
      token: ANVIL.usdc,
      tokenAmount: '7769231',
      fiatCurrency: 'THB',
      fiatAmount: '25000',
    });
    expect(body.pricing).toEqual({
      rateE8: '3250000000',
      rateSource: 'fixed',
      spreadBps: 100,
      baseTokenAmount: '7692308',
      feeTokenAmount: '76923',
    });
    expect(body.merchant).toMatchObject({ kind: 'merchant', targetId: '099999999999901', reference1: 'INV0001' });
    expect(quote.quoteId).toMatch(/^0x[0-9a-f]{64}$/);

    // Expires 60 s from now, on a whole second.
    expect(quote.expiresAt - before).toBeGreaterThanOrEqual(60);
    expect(quote.expiresAt - before).toBeLessThanOrEqual(61);
    expect(new Date(body.expiresAt).getTime()).toBe(quote.expiresAt * 1000);

    // The backend's signature recovers to the quote signer, over exactly the returned struct.
    const signer = await recoverTypedDataAddress({
      domain: { ...SETTLEMENT_DOMAIN, chainId: ANVIL.chainId, verifyingContract: ANVIL.settlement },
      types: QUOTE_TYPES,
      primaryType: 'Quote',
      message: {
        ...quote,
        tokenAmount: BigInt(quote.tokenAmount),
        fiatCurrency: '0x544842',
        fiatAmount: BigInt(quote.fiatAmount),
        expiresAt: BigInt(quote.expiresAt),
      },
      signature: body.signature,
    });
    expect(signer).toBe(ANVIL.accounts.quoteSigner.address);

    expect(repos.state.quotes.get(quote.quoteId)?.userId).toBe(session.userId);
  });

  it('returns typed data the user wallet can sign as is', async () => {
    const { app, session } = await setup();
    const body = (await postQuote(app, session.auth, { payer: session.address, qrPayload: qr250 })).json<QuoteJson>();
    const { authorizationToSign: typed, quote } = body;

    expect(typed.domain).toEqual({ name: 'USDC', version: '2', chainId: ANVIL.chainId, verifyingContract: ANVIL.usdc });
    expect(typed.message).toEqual({
      from: ANVIL.accounts.payer.address,
      to: ANVIL.settlement,
      value: quote.tokenAmount,
      validAfter: '0',
      validBefore: String(quote.expiresAt),
      nonce: quote.quoteId,
    });

    const wallet = privateKeyToAccount(ANVIL.accounts.payer.privateKey);
    const signature = await wallet.signTypedData({
      domain: typed.domain,
      types: typed.types,
      primaryType: typed.primaryType,
      message: typed.message,
    });
    await expect(
      recoverTypedDataAddress({
        domain: typed.domain,
        types: typed.types,
        primaryType: typed.primaryType,
        message: typed.message,
        signature,
      }),
    ).resolves.toBe(wallet.address);
  });

  it('takes the amount from the request for a static QR', async () => {
    const { app, session } = await setup();
    const missing = await postQuote(app, session.auth, { payer: session.address, qrPayload: qrStatic });
    expect(missing.statusCode).toBe(422);
    expect(missing.json().error).toBe('amount_required');

    const ok = await postQuote(app, session.auth, {
      payer: session.address,
      qrPayload: qrStatic,
      fiatAmountMinor: '4500',
    });
    expect(ok.statusCode).toBe(201);
    expect(ok.json<QuoteJson>().quote.fiatAmount).toBe('4500');

    const zero = await postQuote(app, session.auth, {
      payer: session.address,
      qrPayload: qrStatic,
      fiatAmountMinor: '0',
    });
    expect(zero.json().error).toBe('invalid_amount');
  });

  it("refuses to change a dynamic QR's amount", async () => {
    const { app, session } = await setup();
    const changed = await postQuote(app, session.auth, {
      payer: session.address,
      qrPayload: qr250,
      fiatAmountMinor: '100',
    });
    expect(changed.statusCode).toBe(422);
    expect(changed.json().error).toBe('amount_mismatch');

    const same = await postQuote(app, session.auth, {
      payer: session.address,
      qrPayload: qr250,
      fiatAmountMinor: '25000',
    });
    expect(same.statusCode).toBe(201);
  });

  it('refuses personal QRs only when MERCHANT_QR_ONLY is on', async () => {
    const open = await setup();
    const allowed = await postQuote(open.app, open.session.auth, {
      payer: open.session.address,
      qrPayload: qrPersonal,
    });
    expect(allowed.statusCode).toBe(201);
    await open.app.close();

    const strict = await setup({ MERCHANT_QR_ONLY: 'true' });
    const response = await postQuote(strict.app, strict.session.auth, {
      payer: strict.session.address,
      qrPayload: qrPersonal,
    });
    expect(response.statusCode).toBe(422);
    expect(response.json().error).toBe('personal_qr_not_allowed');
  });

  it('rejects an invalid QR with the parser error', async () => {
    const { app, session } = await setup();
    const response = await postQuote(app, session.auth, {
      payer: session.address,
      qrPayload: `${qr250.slice(0, -4)}0000`,
    });
    expect(response.statusCode).toBe(422);
    expect(response.json()).toMatchObject({ error: 'invalid_qr', message: 'QR checksum does not match' });
  });

  it('requires approved KYC', async () => {
    testApp = await buildTestApp();
    const session = await signIn(testApp.app, ANVIL.accounts.payer.privateKey);
    const response = await postQuote(testApp.app, session.auth, { payer: session.address, qrPayload: qr250 });
    expect(response.statusCode).toBe(403);
    expect(response.json().error).toBe('kyc_required');
  });

  it("refuses a payer that isn't the signed-in wallet", async () => {
    const { app, session } = await setup();
    const response = await postQuote(app, session.auth, { payer: ANVIL.accounts.treasury.address, qrPayload: qr250 });
    expect(response.statusCode).toBe(403);
    expect(response.json().error).toBe('payer_mismatch');
  });

  it('enforces the per-payment limit', async () => {
    const { app, session } = await setup();
    const response = await postQuote(app, session.auth, {
      payer: session.address,
      qrPayload: qrStatic,
      fiatAmountMinor: '500001',
    });
    expect(response.statusCode).toBe(422);
    expect(response.json()).toMatchObject({
      error: 'payment_limit_exceeded',
      message: 'The limit per payment is 5000.00 THB',
    });
  });

  it('enforces the 24-hour limit, ignoring refunded payments', async () => {
    const { app, repos, session } = await setup();
    const now = new Date();
    repos.state.payments.push(
      { userId: session.userId, fiatMinor: 19_000_00n, status: 'SETTLED', createdAt: now },
      { userId: session.userId, fiatMinor: 5_000_00n, status: 'REFUNDED', createdAt: now },
      {
        userId: session.userId,
        fiatMinor: 5_000_00n,
        status: 'SETTLED',
        createdAt: new Date(now.getTime() - 25 * 3600_000),
      },
    );

    const quoteStatic = (fiatAmountMinor: string) =>
      postQuote(app, session.auth, { payer: session.address, qrPayload: qrStatic, fiatAmountMinor });

    const over = await quoteStatic('100001');
    expect(over.statusCode).toBe(422);
    expect(over.json()).toMatchObject({
      error: 'daily_limit_exceeded',
      message: 'The 24-hour limit is 20000.00 THB; 1000.00 THB remains',
    });

    const within = await quoteStatic('100000');
    expect(within.statusCode).toBe(201);
  });

  it('requires a signed-in user', async () => {
    testApp = await buildTestApp();
    const response = await postQuote(testApp.app, {}, { payer: ANVIL.accounts.payer.address, qrPayload: qr250 });
    expect(response.statusCode).toBe(401);
  });

  it('validates the body', async () => {
    const { app, session } = await setup();
    const response = await postQuote(app, session.auth, { payer: '0x1234', qrPayload: qr250 });
    expect(response.statusCode).toBe(400);
    expect(response.json().error).toBe('invalid_request');
  });

  it('fails with 503 without a settlement address', async () => {
    testApp = await buildTestApp({ env: { SETTLEMENT_ADDRESS: '' } });
    const session = await signInVerified(testApp.app, ANVIL.accounts.payer.privateKey);
    const response = await postQuote(testApp.app, session.auth, { payer: session.address, qrPayload: qr250 });
    expect(response.statusCode).toBe(503);
    expect(response.json().error).toBe('not_configured');
  });

  it('fails with 503 when the rate is unavailable, and stores nothing', async () => {
    const rates = {
      getRate: async () => {
        throw new AppError('rate_unavailable', 'Exchange rate unavailable', 503);
      },
    };
    const { app, repos, session } = await setup({}, { adapters: { rates } });
    const response = await postQuote(app, session.auth, { payer: session.address, qrPayload: qr250 });
    expect(response.statusCode).toBe(503);
    expect(response.json().error).toBe('rate_unavailable');
    expect(repos.state.quotes.size).toBe(0);
  });
});
