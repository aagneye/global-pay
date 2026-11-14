import { toHex } from 'viem';
import { mnemonicToAccount } from 'viem/accounts';
import { describe, expect, it } from 'vitest';
import { loadEnv } from '../src/config/env.js';
import { ANVIL_PRIVATE_KEYS, isPublicTestKey } from '../src/config/public-test-keys.js';
import { testEnv } from './helpers.js';

const ANVIL_MNEMONIC = 'test test test test test test test test test test test junk';

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

  it('reads the tap-to-pay settings', () => {
    const env = testEnv();
    expect(env.P2P_MAX_AMOUNT_USDC).toBe(1_000_000_000n);
    expect(env.P2P_REQUEST_TTL_MS).toBe(120_000);
    expect(env.FCM_SERVICE_ACCOUNT_FILE).toBeUndefined();
    expect(testEnv({ P2P_MAX_AMOUNT_USDC: '25.5' }).P2P_MAX_AMOUNT_USDC).toBe(25_500_000n);
    expect(() => testEnv({ P2P_MAX_AMOUNT_USDC: '0' })).toThrow(/positive USDC amount/);
  });

  it('reads THB thresholds as satang', () => {
    const env = testEnv({ PAYOUT_FLOAT_BUFFER_THB: '5000.50', OPS_MIN_PAYOUT_FLOAT_THB: '100' });
    expect(env.PAYOUT_FLOAT_BUFFER_THB).toBe(500_050n);
    expect(env.OPS_MIN_PAYOUT_FLOAT_THB).toBe(10_000n);
    expect(() => testEnv({ PAYOUT_FLOAT_BUFFER_THB: 'lots' })).toThrow(/THB amount/);
  });

  it('reads the HTTP hardening settings', () => {
    const env = testEnv();
    expect(env.TRUST_PROXY).toBe(false);
    expect(env.RATE_LIMIT_ENABLED).toBe(true);
    expect(env.RATE_LIMIT_AUTH_MAX).toBe(30);
    expect(testEnv({ TRUST_PROXY: '1' }).TRUST_PROXY).toBe(1);
    expect(testEnv({ TRUST_PROXY: 'true' }).TRUST_PROXY).toBe(true);
    expect(testEnv({ TRUST_PROXY: '10.0.0.0/8, 127.0.0.1' }).TRUST_PROXY).toEqual(['10.0.0.0/8', '127.0.0.1']);
    expect(() => testEnv({ RATE_LIMIT_MAX: '0' })).toThrow(/RATE_LIMIT_MAX/);
  });
});

describe('production checks', () => {
  /** A production configuration that passes every check. (Not real keys.) */
  const production = {
    NODE_ENV: 'production',
    JWT_SECRET: 'q7Vb2mZ9xK4tR1wN8cY3hJ6pL0dF5gSa',
    CHAIN_ID: '8453',
    RPC_URL: 'https://mainnet.base.org',
    PAYOUT_PROVIDER: 'xendit',
    XENDIT_SECRET_KEY: 'xnd_production_x',
    XENDIT_CALLBACK_TOKEN: 'cb_live_x',
    MERCHANT_QR_ONLY: 'true',
    SIWE_DOMAIN: 'api.globalpay.example',
    ONRAMP_PROVIDER: 'moonpay',
    MOONPAY_PUBLISHABLE_KEY: 'pk_live_x',
    MOONPAY_SECRET_KEY: 'sk_live_x',
    MOONPAY_WEBHOOK_KEY: 'wk_live_x',
    MOONPAY_WIDGET_URL: 'https://buy.moonpay.com',
  };
  const refused = (overrides: Record<string, string>) => () => testEnv({ ...production, ...overrides });

  it('accepts a production configuration', () => {
    expect(testEnv(production).NODE_ENV).toBe('production');
  });

  it("refuses the local chain and anvil's public keys", () => {
    expect(refused({ CHAIN_ID: '31337' })).toThrow(/CHAIN_ID 31337 is a local anvil chain/);
    expect(refused({ ONRAMP_CHAIN_ID: '31337' })).toThrow(/ONRAMP_CHAIN_ID 31337/);
    // All ten accounts of anvil's public mnemonic, upper or lower case.
    for (let addressIndex = 0; addressIndex < 10; addressIndex++) {
      const key = toHex(mnemonicToAccount(ANVIL_MNEMONIC, { addressIndex }).getHdKey().privateKey as Uint8Array);
      expect(isPublicTestKey(key)).toBe(true);
      expect(refused({ QUOTE_SIGNER_PRIVATE_KEY: key })).toThrow(/QUOTE_SIGNER_PRIVATE_KEY is one of anvil's public test keys/);
      expect(refused({ RELAYER_PRIVATE_KEY: `0x${key.slice(2).toUpperCase()}` })).toThrow(/RELAYER_PRIVATE_KEY is one of anvil's/);
    }
    const ownKey = toHex(mnemonicToAccount(ANVIL_MNEMONIC, { addressIndex: 10 }).getHdKey().privateKey as Uint8Array);
    expect(testEnv({ ...production, QUOTE_SIGNER_PRIVATE_KEY: ownKey }).QUOTE_SIGNER_PRIVATE_KEY).toBe(ownKey);
    // Development and tests still use them.
    expect(testEnv({ CHAIN_ID: '31337', QUOTE_SIGNER_PRIVATE_KEY: ANVIL_PRIVATE_KEYS[2] as string }).CHAIN_ID).toBe(31337);
  });

  it('refuses guessable secrets', () => {
    expect(refused({ JWT_SECRET: 'x'.repeat(32) })).toThrow(/JWT_SECRET looks guessable/);
    expect(refused({ JWT_SECRET: 'test-secret-test-secret-test-secret-00' })).toThrow(/JWT_SECRET looks guessable/);
    expect(refused({ JWT_SECRET: 'please-change-me-before-launch-2026' })).toThrow(/JWT_SECRET looks guessable/);
    expect(refused({ JWT_SECRET: 'short' })).toThrow(/at least 32 characters/);
    expect(refused({ OPS_API_TOKEN: 'o'.repeat(40) })).toThrow(/OPS_API_TOKEN looks guessable/);
    expect(refused({ OPS_API_TOKEN: production.JWT_SECRET })).toThrow(/OPS_API_TOKEN must differ from JWT_SECRET/);
    expect(testEnv({ ...production, OPS_API_TOKEN: 'Zr4Nq8Lw2Hc6Tv0Bx5Mk9Pj3Fd7Gs1Ya' }).OPS_API_TOKEN).toBeDefined();
  });

  it('refuses sandbox partners and development shortcuts', () => {
    expect(refused({ XENDIT_SECRET_KEY: 'xnd_development_abc' })).toThrow(/Xendit test-mode key/);
    expect(refused({ MOONPAY_PUBLISHABLE_KEY: 'pk_test_abc' })).toThrow(/MOONPAY_PUBLISHABLE_KEY is a MoonPay sandbox key/);
    expect(refused({ MOONPAY_SECRET_KEY: 'sk_test_abc' })).toThrow(/MOONPAY_SECRET_KEY is a MoonPay sandbox key/);
    expect(refused({ MOONPAY_WEBHOOK_KEY: 'wk_test_abc' })).toThrow(/MOONPAY_WEBHOOK_KEY is a MoonPay sandbox key/);
    expect(refused({ MOONPAY_WIDGET_URL: 'https://buy-sandbox.moonpay.com' })).toThrow(/MoonPay's sandbox/);
    const { MOONPAY_WIDGET_URL: _default, ...withDefaultWidget } = production;
    expect(() => testEnv(withDefaultWidget)).toThrow(/MoonPay's sandbox/);
    expect(refused({ RATE_SOURCE: 'fixed' })).toThrow(/RATE_SOURCE=fixed/);
    expect(refused({ RATE_LIMIT_ENABLED: 'false' })).toThrow(/Rate limits cannot be turned off/);
  });

  it('refuses unsigned webhooks, personal QRs and a local sign-in domain', () => {
    const { XENDIT_CALLBACK_TOKEN: _token, ...noCallbackToken } = production;
    expect(() => testEnv(noCallbackToken)).toThrow(/needs XENDIT_CALLBACK_TOKEN/);
    const { MOONPAY_WEBHOOK_KEY: _key, ...noWebhookKey } = production;
    expect(() => testEnv(noWebhookKey)).toThrow(/needs MOONPAY_WEBHOOK_KEY/);
    expect(refused({ MERCHANT_QR_ONLY: 'false' })).toThrow(/MERCHANT_QR_ONLY=true/);
    const { SIWE_DOMAIN: _domain, ...defaultDomain } = production;
    expect(() => testEnv(defaultDomain)).toThrow(/SIWE_DOMAIN is a local name/);
    expect(refused({ SIWE_DOMAIN: 'globalpay.local:3000' })).toThrow(/SIWE_DOMAIN is a local name/);
    // Development keeps the easy defaults.
    expect(testEnv({}).MERCHANT_QR_ONLY).toBe(false);
  });

  it('refuses NEAR testnet and the testnet faucet', () => {
    const near = { SETTLEMENT_RAIL: 'near', ...NEAR_SETTINGS };
    expect(refused(near)).toThrow(/NEAR_NETWORK=testnet is refused in production/);
    expect(testEnv({ ...production, ...near, NEAR_NETWORK: 'mainnet', NEAR_RPC_URL: 'https://free.rpc.fastnear.com' }).NEAR_NETWORK).toBe('mainnet');
    expect(refused({ NEAR_TESTNET_FAUCET: 'true' })).toThrow(/NEAR_TESTNET_FAUCET/);
    // The EVM rail doesn't care about NEAR_NETWORK's default.
    expect(testEnv(production).NEAR_NETWORK).toBe('testnet');
  });
});

/** NEAR rail settings with well-formed placeholder values (not real accounts or keys). */
const NEAR_SETTINGS = {
  NEAR_SETTLEMENT_CONTRACT: 'gp-abc123-settle.testnet',
  NEAR_USDC_CONTRACT: 'gp-abc123-usdc.testnet',
  NEAR_RELAYER_ACCOUNT_ID: 'gp-abc123-relayer.testnet',
  NEAR_RELAYER_PRIVATE_KEY: `ed25519:${'2'.repeat(88)}`,
  NEAR_QUOTE_SIGNER_PRIVATE_KEY: `ed25519:${'3'.repeat(88)}`,
};

describe('NEAR rail settings', () => {
  it('defaults to the EVM rail and NEAR testnet', () => {
    const env = testEnv();
    expect(env.SETTLEMENT_RAIL).toBe('evm');
    expect(env.NEAR_NETWORK).toBe('testnet');
    expect(env.NEAR_RPC_URL).toBe('https://test.rpc.fastnear.com');
    expect(env.NEAR_EXPLORER_URL).toBe('https://testnet.nearblocks.io');
    expect(env.NEAR_TESTNET_FAUCET).toBe(false);
  });

  it('needs the contracts, the relayer and the quote signer on the NEAR rail', () => {
    const env = testEnv({ SETTLEMENT_RAIL: 'near', ...NEAR_SETTINGS, NEAR_TESTNET_FAUCET: 'true' });
    expect(env.NEAR_USDC_CONTRACT).toBe('gp-abc123-usdc.testnet');
    expect(env.NEAR_TESTNET_FAUCET).toBe(true);
    for (const name of Object.keys(NEAR_SETTINGS)) {
      expect(() => testEnv({ SETTLEMENT_RAIL: 'near', ...NEAR_SETTINGS, [name]: '' })).toThrow(/SETTLEMENT_RAIL=near needs/);
    }
    // The EVM rail ignores them.
    expect(testEnv({ NEAR_USDC_CONTRACT: 'usdc.testnet' }).SETTLEMENT_RAIL).toBe('evm');
  });

  it('checks the formats', () => {
    expect(() => testEnv({ NEAR_USDC_CONTRACT: 'Not An Account' })).toThrow(/NEAR_USDC_CONTRACT/);
    expect(() => testEnv({ NEAR_RELAYER_PRIVATE_KEY: '0x1234' })).toThrow(/NEAR_RELAYER_PRIVATE_KEY/);
    expect(() => testEnv({ SETTLEMENT_RAIL: 'solana' })).toThrow(/SETTLEMENT_RAIL/);
    expect(() => testEnv({ NEAR_NETWORK: 'mainnet', NEAR_TESTNET_FAUCET: 'true' })).toThrow(/testnet only/);
  });
});
