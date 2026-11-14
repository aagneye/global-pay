import { describe, expect, it } from 'vitest';
import { FixedRateProvider } from '../src/adapters/rates/fixed-rate-provider.js';
import { isPersonalQr } from '../src/domain/merchant.js';
import { FIAT_DECIMALS, ISO_4217_NUMERIC, TOKEN_DECIMALS } from '../src/domain/money.js';
import { priceInToken } from '../src/domain/pricing.js';
import { merchantRefOf, parseMerchantQr } from '../src/lib/merchant.js';
import { buildPromptPayQr } from '../src/lib/promptpay/build.js';
import { buildUpiQr } from '../src/lib/upi/build.js';
import { UPI_VPA, isUpiQr, parseUpiQr } from '../src/lib/upi/parse.js';

describe('INR', () => {
  it('has 2 decimals and ISO numeric 356', () => {
    expect(FIAT_DECIMALS.INR).toBe(2);
    expect(ISO_4217_NUMERIC.INR).toBe('356');
  });

  it('prices ₹250.00 at 88.00 INR/USDC with a 1% spread', () => {
    const price = priceInToken({
      fiatMinor: 250_00n,
      fiatDecimals: FIAT_DECIMALS.INR,
      tokenDecimals: TOKEN_DECIMALS.USDC,
      rateE8: 88_00000000n,
      spreadBps: 100,
    });
    // 250 / 88 = 2.840909090… USDC → 2.840910 rounded up; × 1.01 = 2.869318181… → 2.869319
    expect(price.baseTokenAmount).toBe(2_840_910n);
    expect(price.tokenAmount).toBe(2_869_319n);
  });

  it('has fixed rates per currency', async () => {
    const rates = new FixedRateProvider({ THB: 32_50000000n, INR: 88_00000000n });
    await expect(rates.getRate('USDC', 'INR')).resolves.toMatchObject({ quote: 'INR', rateE8: 88_00000000n, source: 'fixed' });
    await expect(rates.getRate('USDC', 'THB')).resolves.toMatchObject({ quote: 'THB', rateE8: 32_50000000n });
    await expect(new FixedRateProvider({ THB: 1n }).getRate('USDC', 'INR')).rejects.toMatchObject({ code: 'rate_unavailable' });
  });
});

describe('parseUpiQr', () => {
  it('parses a dynamic merchant QR', () => {
    const raw = 'upi://pay?pa=chai.stall@okaxis&pn=Ravi%20Chai%20%26%20Snacks&am=250.00&cu=INR&mc=5812&tr=ORD-42&tn=Masala%20chai';
    expect(parseUpiQr(raw)).toEqual({
      kind: 'upi',
      raw,
      vpa: 'chai.stall@okaxis',
      name: 'Ravi Chai & Snacks',
      amount: { currency: 'INR', minor: 250_00n },
      merchantCode: '5812',
      reference: 'ORD-42',
      note: 'Masala chai',
    });
    expect(isPersonalQr(parseUpiQr(raw))).toBe(false);
  });

  it('parses a static personal QR: no amount, no currency, no merchant code', () => {
    const merchant = parseUpiQr('upi://pay?pa=ravi-01@ybl&pn=Ravi+Kumar');
    expect(merchant).toEqual({ kind: 'upi', raw: 'upi://pay?pa=ravi-01@ybl&pn=Ravi+Kumar', vpa: 'ravi-01@ybl', name: 'Ravi Kumar' });
    expect(isPersonalQr(merchant)).toBe(true);
  });

  it('takes the scheme and host in any case, and whole-rupee amounts', () => {
    expect(isUpiQr('UPI://Pay?pa=shop@okicici&am=99')).toBe(true);
    expect(parseUpiQr('UPI://Pay?pa=shop@okicici&am=99&cu=inr').amount).toEqual({ currency: 'INR', minor: 99_00n });
  });

  it('refuses a missing or bad VPA', () => {
    expect(() => parseUpiQr('upi://pay?pn=Nobody&am=10')).toThrow(/payee address/);
    expect(() => parseUpiQr('upi://pay?pa=not-a-vpa&am=10')).toThrow(/not a valid UPI ID/);
    expect(() => parseUpiQr('upi://pay?pa=x@okaxis')).toThrow(/not a valid UPI ID/);
    expect(() => parseUpiQr('upi://pay?pa=chai@1bank')).toThrow(/not a valid UPI ID/);
    expect(() => parseUpiQr('upi://pay?pa=chai%20stall@okaxis')).toThrow(/not a valid UPI ID/);
  });

  it('refuses another currency with currency_not_supported', () => {
    expect(() => parseUpiQr('upi://pay?pa=shop@okaxis&am=10&cu=USD')).toThrow(
      expect.objectContaining({ code: 'currency_not_supported', statusCode: 422 }),
    );
  });

  it('refuses amounts with more than 2 decimals, or not positive', () => {
    expect(() => parseUpiQr('upi://pay?pa=shop@okaxis&am=10.001')).toThrow(expect.objectContaining({ code: 'invalid_qr' }));
    expect(() => parseUpiQr('upi://pay?pa=shop@okaxis&am=0')).toThrow(expect.objectContaining({ code: 'invalid_qr' }));
    expect(() => parseUpiQr('upi://pay?pa=shop@okaxis&am=-5')).toThrow(expect.objectContaining({ code: 'invalid_qr' }));
  });

  it('refuses links that are not UPI payments', () => {
    expect(() => parseUpiQr('upi://mandate?pa=shop@okaxis')).toThrow(expect.objectContaining({ code: 'invalid_qr' }));
  });

  it('round-trips what buildUpiQr makes', () => {
    const raw = buildUpiQr({ vpa: 'Chai.Stall@okaxis', name: 'Ravi Chai & Snacks', amountMinor: 250_00n, merchantCode: '5812' });
    expect(raw).toBe('upi://pay?pa=Chai.Stall%40okaxis&pn=Ravi%20Chai%20%26%20Snacks&am=250.00&cu=INR&mc=5812');
    expect(parseUpiQr(raw)).toMatchObject({ vpa: 'Chai.Stall@okaxis', name: 'Ravi Chai & Snacks', merchantCode: '5812' });
  });

  it('validates VPAs', () => {
    expect(UPI_VPA.test('chai.stall@okaxis')).toBe(true);
    expect(UPI_VPA.test('x@okaxis')).toBe(false);
  });
});

describe('parseMerchantQr', () => {
  it('reads UPI and PromptPay QRs, with their payee references', () => {
    const upi = parseMerchantQr('upi://pay?pa=Chai.Stall@okaxis&mc=5812');
    expect(upi.kind).toBe('upi');
    expect(merchantRefOf(upi)).toBe('upi:chai.stall@okaxis');
    const promptpay = parseMerchantQr(buildPromptPayQr({ kind: 'merchant', targetType: 'biller', targetId: '099999999999901' }));
    expect(promptpay).toMatchObject({ kind: 'merchant', targetId: '099999999999901' });
    expect(merchantRefOf(promptpay)).toBe('promptpay:biller:099999999999901');
  });
});
