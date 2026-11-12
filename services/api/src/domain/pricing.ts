import { BPS_SCALE, RATE_SCALE, ceilDiv } from './money.js';

export interface PriceInput {
  /** What the merchant receives, in fiat minor units (THB satang). */
  fiatMinor: bigint;
  fiatDecimals: number;
  tokenDecimals: number;
  /** Mid-market fiat major units per 1 token, × 1e8. */
  rateE8: bigint;
  /** GlobalPay's fee on top of the mid-market amount, in basis points (100 = 1%). */
  spreadBps: number;
}

export interface Price {
  /** What the user pays, in token base units: the mid-market amount plus the spread. */
  tokenAmount: bigint;
  /** The mid-market amount, before the spread. */
  baseTokenAmount: bigint;
  /** tokenAmount − baseTokenAmount. */
  feeTokenAmount: bigint;
}

/**
 * Converts a fiat amount to the token amount the user pays.
 *
 *   base  = fiat / rate
 *   total = fiat / rate × (1 + spread)
 *
 * Everything is exact integer maths with a single division per value, rounded up,
 * so rounding never leaves GlobalPay short of what it owes the merchant.
 */
export function priceInToken(input: PriceInput): Price {
  const { fiatMinor, rateE8, spreadBps } = input;
  if (fiatMinor <= 0n) throw new RangeError('fiat amount must be positive');
  if (rateE8 <= 0n) throw new RangeError('rate must be positive');
  if (!Number.isInteger(spreadBps) || spreadBps < 0 || spreadBps > Number(BPS_SCALE)) {
    throw new RangeError('spread must be an integer from 0 to 10000 basis points');
  }

  // fiatMinor / 10^fiatDecimals major units ÷ (rateE8 / 1e8) = token major units; × 10^tokenDecimals = base units.
  const numerator = fiatMinor * 10n ** BigInt(input.tokenDecimals) * RATE_SCALE;
  const denominator = 10n ** BigInt(input.fiatDecimals) * rateE8;

  const baseTokenAmount = ceilDiv(numerator, denominator);
  const tokenAmount = ceilDiv(numerator * (BPS_SCALE + BigInt(spreadBps)), denominator * BPS_SCALE);
  return { tokenAmount, baseTokenAmount, feeTokenAmount: tokenAmount - baseTokenAmount };
}
