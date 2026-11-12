import { z } from 'zod';
import { type FiatCurrency, RATE_DECIMALS, type TokenSymbol, parseDecimal } from '../../domain/money.js';
import type { Rate, RateProvider } from '../../ports/rate-provider.js';
import { AppError } from '../../shared/errors.js';

export interface PublicFeedRateProviderOptions {
  /** Coinbase's public exchange-rates endpoint (no API key). */
  url?: string;
  /** How long a fetched rate is reused. */
  cacheMs?: number;
  timeoutMs?: number;
  fetch?: typeof fetch;
  now?: () => Date;
}

const DEFAULT_URL = 'https://api.coinbase.com/v2/exchange-rates';

/** `{ data: { currency: "USDC", rates: { THB: "33.7673…" } } }`, rates as decimal strings. */
const ResponseSchema = z.object({
  data: z.object({ currency: z.string(), rates: z.record(z.string(), z.string()) }),
});

/**
 * Demo rates from Coinbase's public feed, cached briefly.
 * The feed returns decimal strings, so the rate is parsed exactly (to 8 decimals) with no floating point.
 * The spread is applied by QuoteService, not here. Production uses the partner exchange's quote API.
 */
export class PublicFeedRateProvider implements RateProvider {
  private readonly url: string;
  private readonly cacheMs: number;
  private readonly timeoutMs: number;
  private readonly fetch: typeof fetch;
  private readonly now: () => Date;
  private readonly cache = new Map<string, Rate>();
  private readonly inFlight = new Map<string, Promise<Rate>>();

  constructor(options: PublicFeedRateProviderOptions = {}) {
    this.url = options.url ?? DEFAULT_URL;
    this.cacheMs = options.cacheMs ?? 30_000;
    this.timeoutMs = options.timeoutMs ?? 5_000;
    this.fetch = options.fetch ?? globalThis.fetch;
    this.now = options.now ?? (() => new Date());
  }

  async getRate(base: TokenSymbol, quote: FiatCurrency): Promise<Rate> {
    const key = `${base}/${quote}`;
    const cached = this.cache.get(key);
    if (cached && this.now().getTime() - cached.fetchedAt.getTime() < this.cacheMs) return cached;

    // Concurrent quotes share one request.
    let pending = this.inFlight.get(key);
    if (!pending) {
      pending = this.fetchRate(base, quote).finally(() => this.inFlight.delete(key));
      this.inFlight.set(key, pending);
    }
    const rate = await pending;
    this.cache.set(key, rate);
    return rate;
  }

  private async fetchRate(base: TokenSymbol, quote: FiatCurrency): Promise<Rate> {
    let body: unknown;
    try {
      const response = await this.fetch(`${this.url}?currency=${base}`, {
        headers: { accept: 'application/json' },
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      body = await response.json();
    } catch (error) {
      throw unavailable(`could not fetch the ${base}/${quote} rate: ${(error as Error).message}`);
    }

    const parsed = ResponseSchema.safeParse(body);
    if (!parsed.success || parsed.data.data.currency !== base) {
      throw unavailable(`unexpected response from the ${base}/${quote} rate feed`);
    }
    const text = parsed.data.data.rates[quote];
    const rateE8 = text === undefined ? null : parseDecimal(text, RATE_DECIMALS, { truncate: true });
    if (rateE8 === null || rateE8 <= 0n) {
      throw unavailable(`the rate feed has no valid ${base}/${quote} rate`);
    }
    return { base, quote, rateE8, source: 'coinbase', fetchedAt: this.now() };
  }
}

function unavailable(message: string): AppError {
  return new AppError('rate_unavailable', `Exchange rate unavailable: ${message}`, 503);
}
