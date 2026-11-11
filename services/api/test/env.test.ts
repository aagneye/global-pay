import { describe, expect, it } from 'vitest';
import { loadEnv } from '../src/config/env.js';
import { testEnv } from './helpers.js';

describe('loadEnv', () => {
  it('applies defaults for Base Sepolia', () => {
    const env = testEnv();
    expect(env.CHAIN_ID).toBe(84532);
    expect(env.QUOTE_TTL_SECONDS).toBe(60);
    expect(env.MERCHANT_QR_ONLY).toBe(false);
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
});
