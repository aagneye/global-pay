import type { FiatCurrency, TokenSymbol } from '../../domain/money.js';
import type { Rate, RateProvider } from '../../ports/rate-provider.js';
import { NotImplementedError } from '../../shared/errors.js';

/**
 * Demo rates from a public USDC/THB feed, cached briefly.
 * The spread is applied by QuoteService, not here.
 */
export class PublicFeedRateProvider implements RateProvider {
  async getRate(_base: TokenSymbol, _quote: FiatCurrency): Promise<Rate> {
    throw new NotImplementedError('Public rate feed', 3);
  }
}
