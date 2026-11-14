/**
 * Money is always an integer in the currency's smallest unit (bigint).
 * Never use floating point for amounts or rates.
 */

export type FiatCurrency = 'THB' | 'INR';
export type TokenSymbol = 'USDC';

export const FIAT_DECIMALS: Record<FiatCurrency, number> = { THB: 2, INR: 2 };
export const TOKEN_DECIMALS: Record<TokenSymbol, number> = { USDC: 6 };

/** ISO 4217 numeric codes, as used in EMVCo QR tag 53. */
export const ISO_4217_NUMERIC: Record<FiatCurrency, string> = { THB: '764', INR: '356' };

/** Fiat amount in minor units, e.g. THB satang (10000n = 100.00 THB) or INR paise. */
export interface FiatAmount {
  currency: FiatCurrency;
  minor: bigint;
}

/** Token amount in base units, e.g. USDC with 6 decimals (1_000_000n = 1 USDC). */
export interface TokenAmount {
  token: TokenSymbol;
  units: bigint;
}

/** Exchange rates are fixed-point integers: fiat major units per 1 token, scaled by 1e8. */
export const RATE_SCALE = 100_000_000n;
export const RATE_DECIMALS = 8;

/** 1 basis point = 0.01%. */
export const BPS_SCALE = 10_000n;

const DECIMAL = /^(\d+)(?:\.(\d+))?$/;

/**
 * Parses a non-negative decimal string such as "100.5" into minor units with `decimals` digits.
 * Returns null if the string isn't a plain decimal. Extra fraction digits make it invalid,
 * unless `truncate` is set, in which case they're dropped (rounding down).
 */
export function parseDecimal(value: string, decimals: number, options: { truncate?: boolean } = {}): bigint | null {
  const match = DECIMAL.exec(value);
  if (!match) return null;
  const whole = match[1] ?? '0';
  let fraction = match[2] ?? '';
  if (fraction.length > decimals) {
    if (!options.truncate) return null;
    fraction = fraction.slice(0, decimals);
  }
  return BigInt(whole + fraction.padEnd(decimals, '0'));
}

/** Formats minor units as a decimal string with exactly `decimals` fraction digits. */
export function formatMinor(minor: bigint, decimals: number): string {
  const negative = minor < 0n;
  const digits = (negative ? -minor : minor).toString().padStart(decimals + 1, '0');
  const whole = digits.slice(0, digits.length - decimals);
  const fraction = digits.slice(digits.length - decimals);
  return `${negative ? '-' : ''}${whole}${decimals > 0 ? `.${fraction}` : ''}`;
}

/** Integer division rounding up. Both operands must be positive. */
export function ceilDiv(numerator: bigint, denominator: bigint): bigint {
  return (numerator + denominator - 1n) / denominator;
}
