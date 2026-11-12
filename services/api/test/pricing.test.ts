import { describe, expect, it } from 'vitest';
import { priceInToken } from '../src/domain/pricing.js';

const THB_USDC = { fiatDecimals: 2, tokenDecimals: 6 };

describe('priceInToken', () => {
  it('prices 100.00 THB at 32.50 THB/USDC with a 1% spread', () => {
    const price = priceInToken({ ...THB_USDC, fiatMinor: 100_00n, rateE8: 32_50000000n, spreadBps: 100 });
    // 100 / 32.5 = 3.0769230769… USDC → 3.076924 rounded up; × 1.01 = 3.1076923076… → 3.107693
    expect(price.baseTokenAmount).toBe(3_076_924n);
    expect(price.tokenAmount).toBe(3_107_693n);
    expect(price.feeTokenAmount).toBe(30_769n);
  });

  it('is exact when the division has no remainder', () => {
    const price = priceInToken({ ...THB_USDC, fiatMinor: 50_00n, rateE8: 25_00000000n, spreadBps: 0 });
    expect(price).toEqual({ tokenAmount: 2_000_000n, baseTokenAmount: 2_000_000n, feeTokenAmount: 0n });
  });

  it('charges at least one base unit for the smallest payment', () => {
    const price = priceInToken({ ...THB_USDC, fiatMinor: 1n, rateE8: 35_00000000n, spreadBps: 100 });
    expect(price.tokenAmount).toBeGreaterThanOrEqual(1n);
  });

  it('never leaves GlobalPay short, for many amounts, rates and spreads', () => {
    let seed = 42;
    const random = (max: number) => {
      seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
      return seed % max;
    };
    for (let i = 0; i < 2_000; i++) {
      const fiatMinor = BigInt(1 + random(10_000_000));
      const rateE8 = BigInt(1 + random(2_000_000_000)) * 10n;
      const spreadBps = random(501);
      const { tokenAmount, baseTokenAmount, feeTokenAmount } = priceInToken({
        ...THB_USDC,
        fiatMinor,
        rateE8,
        spreadBps,
      });

      // tokenAmount (base units) × rate covers fiat × (1 + spread), compared exactly in integers:
      // tokenAmount / 1e6 × rateE8 / 1e8 ≥ fiatMinor / 100 × (10000 + spread) / 10000
      const paid = tokenAmount * rateE8 * 100n * 10_000n;
      const owed = fiatMinor * 1_000_000n * 100_000_000n * (10_000n + BigInt(spreadBps));
      expect(paid >= owed).toBe(true);
      // …and overshoots by less than one base unit.
      expect((tokenAmount - 1n) * rateE8 * 100n * 10_000n < owed).toBe(true);

      expect(feeTokenAmount).toBe(tokenAmount - baseTokenAmount);
      expect(feeTokenAmount >= 0n).toBe(true);
    }
  });

  it('rejects invalid input', () => {
    const ok = { ...THB_USDC, fiatMinor: 100n, rateE8: 1n, spreadBps: 0 };
    expect(() => priceInToken({ ...ok, fiatMinor: 0n })).toThrow(RangeError);
    expect(() => priceInToken({ ...ok, rateE8: 0n })).toThrow(RangeError);
    expect(() => priceInToken({ ...ok, spreadBps: -1 })).toThrow(RangeError);
    expect(() => priceInToken({ ...ok, spreadBps: 1.5 })).toThrow(RangeError);
    expect(() => priceInToken({ ...ok, spreadBps: 10_001 })).toThrow(RangeError);
  });
});
