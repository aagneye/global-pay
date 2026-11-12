import { describe, expect, it, vi } from 'vitest';
import { FixedRateProvider } from '../src/adapters/rates/fixed-rate-provider.js';
import { PublicFeedRateProvider } from '../src/adapters/rates/public-feed-rate-provider.js';
import { AppError } from '../src/shared/errors.js';

function feed(body: unknown, init: { status?: number } = {}) {
  return vi.fn<typeof fetch>(async () => new Response(JSON.stringify(body), { status: init.status ?? 200 }));
}

const usdcRates = { data: { currency: 'USDC', rates: { THB: '33.7673215487947879956', USD: '1' } } };

describe('PublicFeedRateProvider', () => {
  it('parses the decimal rate exactly, truncated to 8 decimals', async () => {
    const fetch = feed(usdcRates);
    const provider = new PublicFeedRateProvider({ fetch, url: 'https://rates.test/v2/exchange-rates' });

    const rate = await provider.getRate('USDC', 'THB');

    expect(rate).toMatchObject({ base: 'USDC', quote: 'THB', rateE8: 3_376_732_154n, source: 'coinbase' });
    expect(fetch).toHaveBeenCalledWith('https://rates.test/v2/exchange-rates?currency=USDC', expect.anything());
  });

  it('caches the rate, and shares one request between concurrent callers', async () => {
    let now = new Date('2026-11-12T00:00:00Z');
    const fetch = feed(usdcRates);
    const provider = new PublicFeedRateProvider({ fetch, cacheMs: 30_000, now: () => now });

    await Promise.all([provider.getRate('USDC', 'THB'), provider.getRate('USDC', 'THB')]);
    now = new Date(now.getTime() + 29_000);
    await provider.getRate('USDC', 'THB');
    expect(fetch).toHaveBeenCalledTimes(1);

    now = new Date(now.getTime() + 2_000);
    await provider.getRate('USDC', 'THB');
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it.each([
    ['an HTTP error', feed({}, { status: 500 })],
    ['a network error', vi.fn<typeof fetch>(async () => Promise.reject(new TypeError('fetch failed')))],
    ['an unexpected body', feed({ rates: {} })],
    ['a different base currency', feed({ data: { currency: 'USDT', rates: { THB: '33' } } })],
    ['no THB rate', feed({ data: { currency: 'USDC', rates: { USD: '1' } } })],
    ['a zero rate', feed({ data: { currency: 'USDC', rates: { THB: '0' } } })],
    ['a non-decimal rate', feed({ data: { currency: 'USDC', rates: { THB: '3.3e1' } } })],
  ])('fails with 503 rate_unavailable on %s', async (_name, fetch) => {
    const provider = new PublicFeedRateProvider({ fetch });
    const error = await provider.getRate('USDC', 'THB').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AppError);
    expect(error).toMatchObject({ code: 'rate_unavailable', statusCode: 503 });
  });

  it('retries after a failure instead of caching it', async () => {
    const flaky = vi
      .fn<typeof fetch>()
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockResolvedValueOnce(new Response(JSON.stringify(usdcRates)));
    const provider = new PublicFeedRateProvider({ fetch: flaky });

    await expect(provider.getRate('USDC', 'THB')).rejects.toThrow(/unavailable/);
    await expect(provider.getRate('USDC', 'THB')).resolves.toMatchObject({ rateE8: 3_376_732_154n });
  });
});

describe('FixedRateProvider', () => {
  it('returns the configured rate', async () => {
    await expect(new FixedRateProvider(35_00000000n).getRate('USDC', 'THB')).resolves.toMatchObject({
      rateE8: 35_00000000n,
      source: 'fixed',
    });
    expect(() => new FixedRateProvider(0n)).toThrow(RangeError);
  });
});
