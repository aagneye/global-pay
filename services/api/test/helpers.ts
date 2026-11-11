import { type Env, loadEnv } from '../src/config/env.js';

/** Minimal valid configuration for tests. No network calls are made with it. */
export function testEnv(overrides: Record<string, string> = {}): Env {
  return loadEnv({
    NODE_ENV: 'test',
    DATABASE_URL: 'postgresql://globalpay:globalpay@localhost:5432/globalpay_test',
    JWT_SECRET: 'test-secret-test-secret-test-secret-00',
    RPC_URL: 'http://127.0.0.1:8545',
    USDC_ADDRESS: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
    ...overrides,
  });
}
