import type { FiatCurrency, TokenSymbol } from '../../domain/money.js';
import type { Rate, RateProvider } from '../../ports/rate-provider.js';

/**
 * A constant rate, for offline development and tests (`RATE_SOURCE=fixed`).
 * Never use it where real money moves.
 */
export class FixedRateProvider implements RateProvider {
  private readonly rateE8: bigint;

  constructor(rateE8: bigint) {
    if (rateE8 <= 0n) throw new RangeError('rate must be positive');
    this.rateE8 = rateE8;
  }

  async getRate(base: TokenSymbol, quote: FiatCurrency): Promise<Rate> {
    return { base, quote, rateE8: this.rateE8, source: 'fixed', fetchedAt: new Date() };
  }
}
