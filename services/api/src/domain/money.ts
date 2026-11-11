/**
 * Money is always an integer in the currency's smallest unit (bigint).
 * Never use floating point for amounts or rates.
 */

export type FiatCurrency = 'THB';
export type TokenSymbol = 'USDC';

export const FIAT_DECIMALS: Record<FiatCurrency, number> = { THB: 2 };
export const TOKEN_DECIMALS: Record<TokenSymbol, number> = { USDC: 6 };

/** ISO 4217 numeric codes, as used in EMVCo QR tag 53. */
export const ISO_4217_NUMERIC: Record<FiatCurrency, string> = { THB: '764' };

/** Fiat amount in minor units, e.g. THB satang (10000n = 100.00 THB). */
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

/** 1 basis point = 0.01%. */
export const BPS_SCALE = 10_000n;
