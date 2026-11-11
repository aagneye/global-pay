import type { FiatCurrency, TokenSymbol } from '../domain/money.js';

export interface Rate {
  base: TokenSymbol;
  quote: FiatCurrency;
  /** Mid-market fiat major units per 1 token, scaled by RATE_SCALE (1e8). No spread applied. */
  rateE8: bigint;
  source: string;
  fetchedAt: Date;
}

/** Exchange-rate source (demo: public feed; production: the partner exchange's quote API). */
export interface RateProvider {
  getRate(base: TokenSymbol, quote: FiatCurrency): Promise<Rate>;
}
