import type { FiatCurrency, TokenSymbol } from '../../domain/money.js';
import type { Rate, RateProvider } from '../../ports/rate-provider.js';
import { AppError } from '../../shared/errors.js';

/**
 * Constant rates, for offline development and tests (`RATE_SOURCE=fixed`): one rateE8 for every currency,
 * or one per currency. Never use it where real money moves.
 */
export class FixedRateProvider implements RateProvider {
  private readonly rates: Partial<Record<FiatCurrency, bigint>> | bigint;

  constructor(rates: bigint | Partial<Record<FiatCurrency, bigint>>) {
    const values = typeof rates === 'bigint' ? [rates] : Object.values(rates);
    if (values.some((rate) => rate <= 0n)) throw new RangeError('rate must be positive');
    this.rates = rates;
  }

  async getRate(base: TokenSymbol, quote: FiatCurrency): Promise<Rate> {
    const rateE8 = typeof this.rates === 'bigint' ? this.rates : this.rates[quote];
    if (rateE8 === undefined) throw new AppError('rate_unavailable', `Exchange rate unavailable: no fixed ${base}/${quote} rate`, 503);
    return { base, quote, rateE8, source: 'fixed', fetchedAt: new Date() };
  }
}
