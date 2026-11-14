import { describe, expect, it } from 'vitest';
import { loadEnv } from '../src/config/env.js';
import { testEnv } from './helpers.js';

describe('loadEnv', () => {
  it('applies defaults for Base Sepolia', () => {
    const env = testEnv();
    expect(env.CHAIN_ID).toBe(84532);
    expect(env.QUOTE_TTL_SECONDS).toBe(60);
    expect(env.MERCHANT_QR_ONLY).toBe(false);
    expect(env.INDEXER_MAX_BLOCK_RANGE).toBe(200n); // Base's public RPCs cap eth_getLogs at 200 blocks
  });

  it('treats empty strings as unset', () => {
    const env = testEnv({ SETTLEMENT_ADDRESS: '', MERCHANT_QR_ONLY: 'true' });
    expect(env.SETTLEMENT_ADDRESS).toBeUndefined();
    expect(env.MERCHANT_QR_ONLY).toBe(true);
  });

  it('rejects a malformed address and a short JWT secret', () => {
    expect(() => testEnv({ USDC_ADDRESS: '0x1234' })).toThrow(/USDC_ADDRESS/);
    expect(() => loadEnv({ JWT_SECRET: 'short' })).toThrow(/JWT_SECRET/);
  });

  it('checks payout settings that only make sense together', () => {
    expect(() => testEnv({ PAYOUT_PROVIDER: 'xendit' })).toThrow(/needs XENDIT_SECRET_KEY/);
    const destinations = '{"099999999999901":{"channelCode":"TH_KBANK","accountNumber":"1","accountHolderName":"Cafe"}}';
    const sandbox = testEnv({ PAYOUT_PROVIDER: 'xendit', XENDIT_SECRET_KEY: 'xnd_development_x', PAYOUT_TEST_DESTINATIONS: destinations });
    expect(sandbox.PAYOUT_TEST_DESTINATIONS?.['099999999999901']?.channelCode).toBe('TH_KBANK');

    const production = { NODE_ENV: 'production', PAYOUT_PROVIDER: 'xendit', XENDIT_SECRET_KEY: 'xnd_production_x' };
    expect(() => testEnv({ ...production, PAYOUT_TEST_DESTINATIONS: destinations })).toThrow(/refused in production/);
    expect(() => testEnv({ ...production, PAYOUT_PROVIDER: 'simulated' })).toThrow(/real payout partner/);
    expect(() => testEnv({ PAYOUT_TEST_DESTINATIONS: 'not json' })).toThrow(/JSON map/);
  });

  it('checks the onramp settings', () => {
    const env = testEnv();
    expect(env.ONRAMP_PROVIDER).toBe('simulated');
    expect(env.ONRAMP_MIN_THB).toBe(800_00n);
    expect(env.MOONPAY_WIDGET_URL).toBe('https://buy-sandbox.moonpay.com');
    expect(() => testEnv({ ONRAMP_PROVIDER: 'moonpay' })).toThrow(/needs MOONPAY_PUBLISHABLE_KEY and MOONPAY_SECRET_KEY/);
    expect(() => testEnv({ ONRAMP_MIN_THB: '1000', ONRAMP_MAX_THB: '500' })).toThrow(/above ONRAMP_MAX_THB/);
    const production = {
      NODE_ENV: 'production',
      PAYOUT_PROVIDER: 'xendit',
      XENDIT_SECRET_KEY: 'xnd_production_x',
    };
    expect(() => testEnv(production)).toThrow(/real onramp partner/);
  });

  it('reads THB thresholds as satang', () => {
    const env = testEnv({ PAYOUT_FLOAT_BUFFER_THB: '5000.50', OPS_MIN_PAYOUT_FLOAT_THB: '100' });
    expect(env.PAYOUT_FLOAT_BUFFER_THB).toBe(500_050n);
    expect(env.OPS_MIN_PAYOUT_FLOAT_THB).toBe(10_000n);
    expect(() => testEnv({ PAYOUT_FLOAT_BUFFER_THB: 'lots' })).toThrow(/THB amount/);
  });
});
