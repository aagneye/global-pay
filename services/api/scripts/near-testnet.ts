/**
 * NEAR testnet helper for the NEAR settlement rail. TESTNET ONLY. Run from services/api:
 *
 *   npm run near:testnet -- init      makes keys for four new accounts (gp-<random>-usdc, -settle, -relayer,
 *                                     -treasury .testnet) and a quote signer, and writes .env.near-testnet
 *                                     (gitignored, never overwritten) with the local database settings of .env
 *   npm run near:testnet -- create    creates the accounts with the testnet faucet (helper.nearprotocol.com)
 *   npm run near:testnet -- deploy    deploys contracts-near/res/test_usdc.wasm and settlement.wasm, calls `new`
 *                                     on both, and registers the settlement, treasury and relayer on the token
 *   npm run near:testnet -- status    balances, contract settings and the next step
 *   npm run near:testnet -- mint <account> <USDC>
 *                                     mints test USDC (the relayer is the token's minter), registering the account
 *
 * Then: npm run dev:near (the API on port 3001 with .env.near-testnet). Private keys are never printed.
 *
 * Roles: the usdc account owns the test token; the settle account holds the settlement contract and owns it;
 * the relayer pays users' gas, is the settlement operator (settle/refund) and the token's minter; settled
 * USDC goes to the treasury.
 */
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseEnv } from 'node:util';
import {
  type Action,
  KeyPair,
  KeyPairSigner,
  type KeyPairString,
  actions,
  baseDecode,
  baseEncode,
  createTransaction,
  formatNearAmount,
} from 'near-api-js';
import { NearRpc, NearRpcError } from '../src/adapters/near/rpc.js';
import { TOKEN_DECIMALS, parseDecimal } from '../src/domain/money.js';
import { setEnvValue } from './testnet.js';

const API_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const NEAR_PATHS = {
  env: join(API_DIR, '.env.near-testnet'),
  localEnv: join(API_DIR, '.env'),
  example: join(API_DIR, '.env.example'),
  wasmDir: resolve(API_DIR, '../../contracts-near/res'),
};
const RPC_URL = 'https://test.rpc.fastnear.com';
const FAUCET_URL = 'https://helper.nearprotocol.com/account';
const EXPLORER = 'https://testnet.nearblocks.io';
const TGAS = 1_000_000_000_000n;

type Role = 'usdc' | 'settle' | 'relayer' | 'treasury';
const ROLES: Role[] = ['usdc', 'settle', 'relayer', 'treasury'];

export interface NearTestnetKeys {
  accounts: Record<Role, { accountId: string; privateKey: string }>;
  quoteSignerPrivateKey: string;
}

// ---------------------------------------------------------------------------------------------------
// Pure helpers (tested in test/near-testnet-script.test.ts)

/** gp-<6 random lowercase letters and digits>-<role>.testnet */
export function accountIds(tag: string): Record<Role, string> {
  if (!/^[a-z0-9]{6}$/.test(tag)) throw new Error('the tag is 6 lowercase letters or digits');
  return Object.fromEntries(ROLES.map((role) => [role, `gp-${tag}-${role}.testnet`])) as Record<Role, string>;
}

export function randomTag(): string {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789';
  return [...randomBytes(6)].map((byte) => alphabet[byte % alphabet.length]).join('');
}

/** The API settings for the NEAR rail on top of `base` (the local .env, or .env.example). */
export function nearTestnetEnv(base: string, keys: NearTestnetKeys): string {
  const { accounts } = keys;
  let env = base;
  if (!/^JWT_SECRET=.{32,}$/m.test(env)) env = setEnvValue(env, 'JWT_SECRET', randomBytes(32).toString('hex'));
  const values: [string, string, string?][] = [
    ['PORT', '3001'],
    ['SETTLEMENT_RAIL', 'near', 'NEAR testnet rail (written by `npm run near:testnet -- init`).'],
    ['NEAR_NETWORK', 'testnet'],
    ['NEAR_RPC_URL', RPC_URL],
    ['NEAR_EXPLORER_URL', EXPLORER],
    ['NEAR_SETTLEMENT_CONTRACT', accounts.settle.accountId],
    ['NEAR_USDC_CONTRACT', accounts.usdc.accountId],
    ['NEAR_RELAYER_ACCOUNT_ID', accounts.relayer.accountId],
    ['NEAR_RELAYER_PRIVATE_KEY', accounts.relayer.privateKey],
    ['NEAR_QUOTE_SIGNER_PRIVATE_KEY', keys.quoteSignerPrivateKey],
    ['NEAR_TREASURY_ACCOUNT_ID', accounts.treasury.accountId],
    ['NEAR_TESTNET_FAUCET', 'true'],
    ['INDEXER_CONFIRMATIONS', '0'],
    ['NEAR_USDC_PRIVATE_KEY', accounts.usdc.privateKey, 'Keys of the contract and treasury accounts, for this script only. Not read by the API.'],
    ['NEAR_SETTLE_PRIVATE_KEY', accounts.settle.privateKey],
    ['NEAR_TREASURY_PRIVATE_KEY', accounts.treasury.privateKey],
  ];
  for (const [key, value, comment] of values) env = setEnvValue(env, key, value, comment);
  return env;
}

/** The settlement contract's `new` arguments. */
export function settlementInitArgs(keys: NearTestnetKeys) {
  const { accounts } = keys;
  return {
    owner: accounts.settle.accountId,
    operator: accounts.relayer.accountId,
    treasury: accounts.treasury.accountId,
    token: accounts.usdc.accountId,
    quote_signer_pk: KeyPair.fromString(keys.quoteSignerPrivateKey as KeyPairString).getPublicKey().toString(),
  };
}

/** The test token's `new` arguments: the usdc account owns it, the relayer mints (testnet faucet). */
export function tokenInitArgs(keys: NearTestnetKeys) {
  return { owner_id: keys.accounts.usdc.accountId, minter_id: keys.accounts.relayer.accountId };
}

// ---------------------------------------------------------------------------------------------------
// Chain helpers

const show = (path: string) => relative(process.cwd(), path) || path;
const rpc = new NearRpc({ url: RPC_URL, timeoutMs: 60_000 });

function readKeys(): NearTestnetKeys {
  if (!existsSync(NEAR_PATHS.env)) throw new Error(`${show(NEAR_PATHS.env)} is missing: run \`npm run near:testnet -- init\` first`);
  const env = parseEnv(readFileSync(NEAR_PATHS.env, 'utf8')) as Record<string, string | undefined>;
  const need = (name: string) => {
    const value = env[name];
    if (!value) throw new Error(`${name} is missing from ${show(NEAR_PATHS.env)}`);
    return value;
  };
  return {
    accounts: {
      usdc: { accountId: need('NEAR_USDC_CONTRACT'), privateKey: need('NEAR_USDC_PRIVATE_KEY') },
      settle: { accountId: need('NEAR_SETTLEMENT_CONTRACT'), privateKey: need('NEAR_SETTLE_PRIVATE_KEY') },
      relayer: { accountId: need('NEAR_RELAYER_ACCOUNT_ID'), privateKey: need('NEAR_RELAYER_PRIVATE_KEY') },
      treasury: { accountId: need('NEAR_TREASURY_ACCOUNT_ID'), privateKey: need('NEAR_TREASURY_PRIVATE_KEY') },
    },
    quoteSignerPrivateKey: need('NEAR_QUOTE_SIGNER_PRIVATE_KEY'),
  };
}

async function balance(accountId: string): Promise<bigint | null> {
  try {
    return BigInt((await rpc.viewAccount(accountId)).amount);
  } catch (error) {
    if (error instanceof NearRpcError && error.kind === 'UNKNOWN_ACCOUNT') return null;
    throw error;
  }
}

async function view<T>(contract: string, method: string, args: object = {}): Promise<T | undefined> {
  try {
    return await rpc.viewFunction<T>(contract, method, args);
  } catch {
    return undefined; // no contract yet, or not initialised
  }
}

/** Signs and sends a transaction, waits until it's final, and throws if it or a receipt failed. */
async function send(from: { accountId: string; privateKey: string }, receiverId: string, txActions: Action[], what: string): Promise<string> {
  const signer = KeyPairSigner.fromSecretKey(from.privateKey as KeyPairString);
  const publicKey = await signer.getPublicKey();
  const [key, block] = await Promise.all([rpc.viewAccessKey(from.accountId, publicKey.toString()), rpc.block({ finality: 'final' })]);
  const tx = createTransaction(from.accountId, publicKey, receiverId, BigInt(key.nonce) + 1n, txActions, baseDecode(block.header.hash));
  const { signedTransaction, txHash } = await signer.signTransaction(tx);
  const hash = baseEncode(txHash);
  let outcome = await rpc.sendTx(Buffer.from(signedTransaction.encode()).toString('base64'), 'FINAL').catch((error: unknown) => {
    if (error instanceof NearRpcError && error.kind === 'TIMEOUT_ERROR') return null; // still on its way
    throw error;
  });
  for (let attempt = 0; !outcome; attempt++) {
    if (attempt > 10) throw new Error(`${what}: no final outcome yet, check ${EXPLORER}/txns/${hash}`);
    outcome = await rpc.txStatus(hash, from.accountId, 'FINAL').catch(() => null);
  }
  const failed = [outcome.status, ...(outcome.receipts_outcome ?? []).map((r) => r.outcome.status)].find(
    (status) => typeof status === 'object' && status !== null && 'Failure' in status,
  );
  if (failed) throw new Error(`${what} failed: ${JSON.stringify(failed)} (${EXPLORER}/txns/${hash})`);
  console.log(`  ${what}: ${EXPLORER}/txns/${hash}`);
  return hash;
}

async function storageDeposit(payer: { accountId: string; privateKey: string }, token: string, accountId: string): Promise<void> {
  if (await view(token, 'storage_balance_of', { account_id: accountId })) return;
  const bounds = await view<{ min: string }>(token, 'storage_balance_bounds');
  if (!bounds) throw new Error(`${token} has no storage_balance_bounds: is the token deployed?`);
  await send(
    payer,
    token,
    [actions.functionCall('storage_deposit', { account_id: accountId, registration_only: true }, 30n * TGAS, BigInt(bounds.min))],
    `storage_deposit for ${accountId}`,
  );
}

// ---------------------------------------------------------------------------------------------------
// Commands

function init(): void {
  if (existsSync(NEAR_PATHS.env)) {
    throw new Error(`${show(NEAR_PATHS.env)} already exists. It may hold funded keys, so it's never overwritten; delete it to start over.`);
  }
  const ids = accountIds(randomTag());
  const keys: NearTestnetKeys = {
    accounts: Object.fromEntries(
      ROLES.map((role) => [role, { accountId: ids[role], privateKey: KeyPair.fromRandom('ed25519').toString() }]),
    ) as NearTestnetKeys['accounts'],
    quoteSignerPrivateKey: KeyPair.fromRandom('ed25519').toString(),
  };
  const baseFile = existsSync(NEAR_PATHS.localEnv) ? NEAR_PATHS.localEnv : NEAR_PATHS.example;
  writeFileSync(NEAR_PATHS.env, nearTestnetEnv(readFileSync(baseFile, 'utf8'), keys), { mode: 0o600 });

  console.log(`Wrote ${show(NEAR_PATHS.env)} from ${show(baseFile)} (gitignored; keys not shown).\n`);
  for (const role of ROLES) console.log(`  ${role.padEnd(9)} ${ids[role]}`);
  console.log(`  quote signer public key: ${settlementInitArgs(keys).quote_signer_pk}`);
  console.log('\nNext: npm run near:testnet -- create');
}

async function create(): Promise<void> {
  const keys = readKeys();
  for (const role of ROLES) {
    const { accountId, privateKey } = keys.accounts[role];
    if ((await balance(accountId)) !== null) {
      console.log(`  ${accountId} exists`);
      continue;
    }
    const publicKey = KeyPair.fromString(privateKey as KeyPairString).getPublicKey().toString();
    const response = await fetch(FAUCET_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ newAccountId: accountId, newAccountPublicKey: publicKey }),
    });
    if (!response.ok) throw new Error(`The faucet refused ${accountId}: HTTP ${response.status} ${await response.text()}`);
    for (let attempt = 0; (await balance(accountId)) === null; attempt++) {
      if (attempt > 30) throw new Error(`${accountId} did not appear on testnet`);
      await new Promise((r) => setTimeout(r, 2_000));
    }
    console.log(`  created ${accountId}: ${EXPLORER}/address/${accountId}`);
  }
  console.log('\nNext: npm run near:testnet -- deploy');
}

async function deploy(args: string[]): Promise<void> {
  const keys = readKeys();
  const { usdc, settle, relayer, treasury } = keys.accounts;
  const flag = args.indexOf('--wasm-dir');
  const wasmDir = flag === -1 ? NEAR_PATHS.wasmDir : resolve(args[flag + 1] ?? '');
  const wasm = (name: string) => {
    const path = join(wasmDir, name);
    if (!existsSync(path)) throw new Error(`${show(path)} is missing (build contracts-near, or pass --wasm-dir)`);
    return new Uint8Array(readFileSync(path));
  };

  if (await view(usdc.accountId, 'get_owner')) {
    console.log(`  ${usdc.accountId}: test USDC already deployed`);
  } else {
    await send(
      usdc,
      usdc.accountId,
      [actions.deployContract(wasm('test_usdc.wasm')), actions.functionCall('new', tokenInitArgs(keys), 100n * TGAS, 0n)],
      'deploy test USDC',
    );
  }

  if (await view(settle.accountId, 'get_config')) {
    console.log(`  ${settle.accountId}: settlement already deployed`);
  } else {
    await send(
      settle,
      settle.accountId,
      [actions.deployContract(wasm('settlement.wasm')), actions.functionCall('new', settlementInitArgs(keys), 100n * TGAS, 0n)],
      'deploy settlement',
    );
  }

  // The settlement holds USDC, the treasury receives it, and the relayer may hold some (refund tests).
  for (const account of [settle, treasury, relayer]) await storageDeposit(relayer, usdc.accountId, account.accountId);
  console.log('\nNext: npm run near:testnet -- status, then npm run dev:near');
}

async function status(): Promise<void> {
  const keys = readKeys();
  const { usdc, settle } = keys.accounts;
  console.log('Accounts (NEAR):');
  for (const role of ROLES) {
    const { accountId } = keys.accounts[role];
    const amount = await balance(accountId);
    const usdcUnits = amount === null ? undefined : await view<string>(usdc.accountId, 'ft_balance_of', { account_id: accountId });
    const shown = amount === null ? 'missing' : `${formatNearAmount(amount.toString(), 4)} NEAR`;
    console.log(`  ${role.padEnd(9)} ${accountId.padEnd(34)} ${shown}${usdcUnits ? `, ${Number(usdcUnits) / 1e6} USDC` : ''}`);
  }
  const token = { owner: await view(usdc.accountId, 'get_owner'), minter: await view(usdc.accountId, 'get_minter') };
  console.log(`\nTest USDC ${usdc.accountId}: ${token.owner ? JSON.stringify(token) : 'not deployed'}`);
  const config = await view(settle.accountId, 'get_config');
  console.log(`Settlement ${settle.accountId}: ${config ? JSON.stringify(config) : 'not deployed'}`);
  if (config) console.log(`  paid_count: ${await view(settle.accountId, 'paid_count')}`);
  const expected = settlementInitArgs(keys).quote_signer_pk;
  if (config && (config as { quote_signer_pk?: string }).quote_signer_pk !== expected) {
    console.log(`  WARNING: quote_signer_pk is not NEAR_QUOTE_SIGNER_PRIVATE_KEY's public key (${expected})`);
  }
  const next = !(await balance(settle.accountId)) ? 'create' : !config || !token.owner ? 'deploy' : null;
  console.log(next ? `\nNext: npm run near:testnet -- ${next}` : '\nReady: npm run dev:near');
}

async function mint(args: string[]): Promise<void> {
  const [accountId, amount] = args;
  const units = amount ? parseDecimal(amount, TOKEN_DECIMALS.USDC) : null;
  if (!accountId || units === null || units <= 0n) throw new Error('Usage: npm run near:testnet -- mint <account> <USDC>');
  const { usdc, relayer } = readKeys().accounts;
  await storageDeposit(relayer, usdc.accountId, accountId);
  await send(relayer, usdc.accountId, [actions.functionCall('mint', { account_id: accountId, amount: units.toString() }, 30n * TGAS, 0n)], `mint ${amount} USDC to ${accountId}`);
}

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);
  if (command === 'init') return init();
  if (command === 'create') return create();
  if (command === 'deploy') return deploy(args);
  if (command === 'status') return status();
  if (command === 'mint') return mint(args);
  throw new Error('Usage: npm run near:testnet -- init | create | deploy [--wasm-dir DIR] | status | mint <account> <USDC>');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    console.error((error as Error).message);
    process.exit(1);
  });
}
