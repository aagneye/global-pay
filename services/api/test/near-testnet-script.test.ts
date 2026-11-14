import { readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';
import { describe, expect, it } from 'vitest';
import { loadEnv } from '../src/config/env.js';
import {
  NEAR_PATHS,
  type NearTestnetKeys,
  accountIds,
  nearTestnetEnv,
  randomTag,
  settlementInitArgs,
  tokenInitArgs,
} from '../scripts/near-testnet.js';
import { nearTestKey } from './support/near.js';

const ids = accountIds('abc123');
const keys: NearTestnetKeys = {
  accounts: {
    usdc: { accountId: ids.usdc, privateKey: nearTestKey('usdc').toString() },
    settle: { accountId: ids.settle, privateKey: nearTestKey('settle').toString() },
    relayer: { accountId: ids.relayer, privateKey: nearTestKey('relayer').toString() },
    treasury: { accountId: ids.treasury, privateKey: nearTestKey('treasury').toString() },
  },
  quoteSignerPrivateKey: nearTestKey('quote-signer').toString(),
};

describe('near:testnet script', () => {
  it('names the four accounts gp-<tag>-<role>.testnet', () => {
    expect(ids).toEqual({
      usdc: 'gp-abc123-usdc.testnet',
      settle: 'gp-abc123-settle.testnet',
      relayer: 'gp-abc123-relayer.testnet',
      treasury: 'gp-abc123-treasury.testnet',
    });
    expect(randomTag()).toMatch(/^[a-z0-9]{6}$/);
    expect(() => accountIds('ABC')).toThrow();
  });

  it('writes settings the API loads on the NEAR rail, keeping the local database settings', () => {
    const local = 'DATABASE_URL=postgresql://local/db\nDATABASE_POOL_SIZE=1\nJWT_SECRET=\nRPC_URL=http://127.0.0.1:8545\nUSDC_ADDRESS=0x5FbDB2315678afecb367f032d93F642f64180aa3\n';
    const text = nearTestnetEnv(local, keys);
    const values = parseEnv(text) as Record<string, string>;
    expect(values).toMatchObject({
      DATABASE_URL: 'postgresql://local/db',
      DATABASE_POOL_SIZE: '1',
      PORT: '3001',
      SETTLEMENT_RAIL: 'near',
      NEAR_TESTNET_FAUCET: 'true',
      INDEXER_CONFIRMATIONS: '0',
      NEAR_USDC_CONTRACT: ids.usdc,
      NEAR_SETTLEMENT_CONTRACT: ids.settle,
      NEAR_RELAYER_ACCOUNT_ID: ids.relayer,
      NEAR_TREASURY_ACCOUNT_ID: ids.treasury,
    });
    expect(values.JWT_SECRET).toMatch(/^[0-9a-f]{64}$/);
    const env = loadEnv(values);
    expect(env.SETTLEMENT_RAIL).toBe('near');
    expect(env.NEAR_RELAYER_PRIVATE_KEY).toBe(keys.accounts.relayer.privateKey);
  });

  it('starts from .env.example when there is no local .env', () => {
    const values = parseEnv(nearTestnetEnv(readFileSync(NEAR_PATHS.example, 'utf8'), keys)) as Record<string, string>;
    expect(loadEnv(values).NEAR_SETTLEMENT_CONTRACT).toBe(ids.settle);
  });

  it('initialises the contracts with the agreed arguments', () => {
    expect(tokenInitArgs(keys)).toEqual({ owner_id: ids.usdc, minter_id: ids.relayer });
    expect(settlementInitArgs(keys)).toEqual({
      owner: ids.settle,
      operator: ids.relayer,
      treasury: ids.treasury,
      token: ids.usdc,
      quote_signer_pk: nearTestKey('quote-signer').getPublicKey().toString(),
    });
  });
});
