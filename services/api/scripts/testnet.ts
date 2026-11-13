/**
 * Base Sepolia helper. TESTNET ONLY. Run from services/api:
 *
 *   npm run testnet -- init     makes testnet keys and writes contracts/.env and .env.base-sepolia
 *                               (never overwrites them), then lists the addresses to fund
 *   npm run testnet -- status   balances, the deployment and its roles on Base Sepolia, and the next step
 *   npm run testnet -- record   after deploying: copies the contract address and block from the broadcast
 *                               record into .env.base-sepolia
 *   npm run testnet -- pay [THB] [--api http://localhost:3000]
 *                               one payment through the running API, as the test payer
 *
 * Private keys go only into gitignored files and are never printed. See docs/testnet.md.
 */
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseEnv } from 'node:util';
import {
  type Address,
  type Hex,
  createPublicClient,
  erc20Abi,
  formatEther,
  formatUnits,
  getAddress,
  http,
  keccak256,
  parseAbi,
  parseEther,
  toHex,
} from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { baseSepolia } from 'viem/chains';
import { FIAT_DECIMALS, parseDecimal } from '../src/domain/money.js';
import { buildPromptPayQr } from '../src/lib/promptpay/build.js';

const API_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CONTRACTS_DIR = resolve(API_DIR, '../../contracts');
export const PATHS = {
  apiEnv: join(API_DIR, '.env.base-sepolia'),
  apiExample: join(API_DIR, '.env.example'),
  contractsEnv: join(CONTRACTS_DIR, '.env'),
  contractsExample: join(CONTRACTS_DIR, '.env.example'),
  broadcast: join(CONTRACTS_DIR, 'broadcast', 'Deploy.s.sol', String(baseSepolia.id), 'run-latest.json'),
};

/** Minimums worth having before deploying and paying. */
const NEED = { deployerWei: parseEther('0.002'), relayerWei: parseEther('0.005'), payerUsdc: 1_000_000n };

// ---------------------------------------------------------------------------------------------------
// Pure helpers (tested in test/testnet-script.test.ts)

/** Sets `KEY=value` in a .env text: replaces the first uncommented line for KEY, or appends one. */
export function setEnvValue(text: string, key: string, value: string, comment?: string): string {
  const line = new RegExp(`^${key}=.*$`, 'm');
  if (line.test(text)) return text.replace(line, `${key}=${value}`);
  const tail = text.endsWith('\n') ? '' : '\n';
  return `${text}${tail}${comment ? `\n# ${comment}\n` : ''}${key}=${value}\n`;
}

/** The settlement contract's address and deployment block, from a `forge script --broadcast` record. */
export function readDeployment(record: unknown): { address: Address; block: bigint } {
  const { transactions = [], receipts = [] } = record as {
    transactions?: { transactionType?: string; contractName?: string; contractAddress?: string; hash?: string }[];
    receipts?: { transactionHash?: string; blockNumber?: string; contractAddress?: string | null }[];
  };
  const create = transactions.find((tx) => tx.transactionType === 'CREATE' && tx.contractName === 'GlobalPaySettlement');
  if (!create?.contractAddress) throw new Error('No GlobalPaySettlement deployment in the broadcast record');
  const receipt = receipts.find((r) => r.transactionHash === create.hash);
  if (!receipt?.blockNumber) throw new Error('The deployment has no receipt yet: was it broadcast?');
  return { address: getAddress(create.contractAddress), block: BigInt(receipt.blockNumber) };
}

// ---------------------------------------------------------------------------------------------------
// Commands

const show = (path: string) => relative(process.cwd(), path) || path;
const readEnv = (path: string): Record<string, string> => {
  if (!existsSync(path)) throw new Error(`${show(path)} is missing: run \`npm run testnet -- init\` first`);
  return parseEnv(readFileSync(path, 'utf8')) as Record<string, string>;
};

function init(): void {
  for (const path of [PATHS.contractsEnv, PATHS.apiEnv]) {
    if (existsSync(path)) {
      throw new Error(`${show(path)} already exists. It may hold funded keys, so it's never overwritten; delete it to start over.`);
    }
  }
  const keys = {
    deployer: generatePrivateKey(),
    quoteSigner: generatePrivateKey(),
    relayer: generatePrivateKey(),
    treasury: generatePrivateKey(),
    payer: generatePrivateKey(),
  };
  const address = Object.fromEntries(
    Object.entries(keys).map(([name, key]) => [name, privateKeyToAccount(key).address]),
  ) as Record<keyof typeof keys, Address>;

  let contracts = readFileSync(PATHS.contractsExample, 'utf8');
  contracts = setEnvValue(contracts, 'DEPLOYER_PRIVATE_KEY', keys.deployer);
  contracts = setEnvValue(contracts, 'QUOTE_SIGNER_ADDRESS', address.quoteSigner);
  contracts = setEnvValue(contracts, 'OPERATOR_ADDRESS', address.relayer);
  contracts = setEnvValue(contracts, 'PAUSER_ADDRESS', address.deployer);
  contracts = setEnvValue(contracts, 'TREASURY_ADDRESS', address.treasury);
  contracts = setEnvValue(contracts, 'TREASURY_PRIVATE_KEY', keys.treasury, 'Treasury key (testnet), to move settled test USDC back. Not used by the deploy script.');

  let api = readFileSync(PATHS.apiExample, 'utf8');
  api = setEnvValue(api, 'JWT_SECRET', randomBytes(32).toString('hex'));
  api = setEnvValue(api, 'QUOTE_SIGNER_PRIVATE_KEY', keys.quoteSigner);
  api = setEnvValue(api, 'RELAYER_PRIVATE_KEY', keys.relayer);
  api = setEnvValue(api, 'OPS_API_TOKEN', randomBytes(24).toString('hex'));
  api = setEnvValue(api, 'E2E_PAYER_PRIVATE_KEY', keys.payer, 'Testnet payer for `npm run testnet -- pay`. Not read by the API.');

  writeFileSync(PATHS.contractsEnv, contracts, { mode: 0o600 });
  writeFileSync(PATHS.apiEnv, api, { mode: 0o600 });

  console.log(`Wrote ${show(PATHS.contractsEnv)} and ${show(PATHS.apiEnv)} (gitignored; keys not shown).\n`);
  console.log('Addresses:');
  console.log(`  deployer (admin, pauser)  ${address.deployer}   fund with Base Sepolia ETH`);
  console.log(`  relayer (operator)        ${address.relayer}   fund with Base Sepolia ETH`);
  console.log(`  test payer                ${address.payer}   fund with Circle test USDC (no ETH needed)`);
  console.log(`  quote signer              ${address.quoteSigner}   nothing to fund`);
  console.log(`  treasury                  ${address.treasury}   nothing to fund`);
  console.log('\nThen run `npm run testnet -- status`. Steps: docs/testnet.md');
}

const roleAbi = parseAbi([
  'function hasRole(bytes32 role, address account) view returns (bool)',
  'function isTokenAllowed(address token) view returns (bool)',
  'function treasury() view returns (address)',
]);
const ROLE = (name: string) => keccak256(toHex(name));

async function status(): Promise<void> {
  const contracts = readEnv(PATHS.contractsEnv);
  const api = readEnv(PATHS.apiEnv);
  const rpc = api.RPC_URL ?? baseSepolia.rpcUrls.default.http[0];
  const client = createPublicClient({ chain: baseSepolia, transport: http(rpc) });
  const chainId = await client.getChainId();
  if (chainId !== baseSepolia.id) throw new Error(`${rpc} is chain ${chainId}, not Base Sepolia`);

  const usdc = getAddress(api.USDC_ADDRESS ?? contracts.USDC_ADDRESS ?? '');
  const deployer = privateKeyToAccount(contracts.DEPLOYER_PRIVATE_KEY as Hex).address;
  const relayer = privateKeyToAccount(api.RELAYER_PRIVATE_KEY as Hex).address;
  const quoteSigner = privateKeyToAccount(api.QUOTE_SIGNER_PRIVATE_KEY as Hex).address;
  const payer = api.E2E_PAYER_PRIVATE_KEY ? privateKeyToAccount(api.E2E_PAYER_PRIVATE_KEY as Hex).address : undefined;
  const treasury = getAddress(contracts.TREASURY_ADDRESS ?? '');
  const usdcOf = (owner: Address) => client.readContract({ address: usdc, abi: erc20Abi, functionName: 'balanceOf', args: [owner] });

  const [deployerWei, relayerWei, payerUsdc, treasuryUsdc] = await Promise.all([
    client.getBalance({ address: deployer }),
    client.getBalance({ address: relayer }),
    payer ? usdcOf(payer) : Promise.resolve(0n),
    usdcOf(treasury),
  ]);
  const tick = (ok: boolean) => (ok ? '✓' : '✗');
  const steps: string[] = [];
  console.log(`Base Sepolia via ${rpc}, block ${await client.getBlockNumber()}\n`);
  console.log(`${tick(deployerWei >= NEED.deployerWei)} deployer    ${deployer}  ${formatEther(deployerWei)} ETH`);
  console.log(`${tick(relayerWei >= NEED.relayerWei)} relayer     ${relayer}  ${formatEther(relayerWei)} ETH`);
  if (payer) console.log(`${tick(payerUsdc >= NEED.payerUsdc)} test payer  ${payer}  ${formatUnits(payerUsdc, 6)} USDC`);
  console.log(`  treasury    ${treasury}  ${formatUnits(treasuryUsdc, 6)} USDC`);
  if (deployerWei < NEED.deployerWei) steps.push(`Send Base Sepolia ETH to the deployer ${deployer}`);
  if (relayerWei < NEED.relayerWei) steps.push(`Send Base Sepolia ETH to the relayer ${relayer}`);
  if (payer && payerUsdc < NEED.payerUsdc) steps.push(`Send Circle test USDC to the test payer ${payer}`);

  const settlement = api.SETTLEMENT_ADDRESS ? getAddress(api.SETTLEMENT_ADDRESS) : undefined;
  if (!settlement) {
    console.log('\n✗ not deployed yet (SETTLEMENT_ADDRESS is empty)');
    steps.push('Deploy: cd contracts && forge script script/Deploy.s.sol --rpc-url base_sepolia --broadcast');
    steps.push('Then: npm run testnet -- record');
  } else {
    const code = await client.getCode({ address: settlement });
    if (!code || code === '0x') {
      console.log(`\n✗ no contract at SETTLEMENT_ADDRESS ${settlement}`);
      steps.push('Check SETTLEMENT_ADDRESS, or deploy again and run `npm run testnet -- record`');
    } else {
      const read = (functionName: 'hasRole' | 'isTokenAllowed' | 'treasury', args: readonly unknown[]) =>
        client.readContract({ address: settlement, abi: roleAbi, functionName, args } as never) as Promise<unknown>;
      const checks: [string, boolean][] = [
        ['quote signer has QUOTE_SIGNER_ROLE', (await read('hasRole', [ROLE('QUOTE_SIGNER_ROLE'), quoteSigner])) === true],
        ['relayer has OPERATOR_ROLE', (await read('hasRole', [ROLE('OPERATOR_ROLE'), relayer])) === true],
        ['USDC is allowed', (await read('isTokenAllowed', [usdc])) === true],
        ['treasury matches', getAddress(String(await read('treasury', []))) === treasury],
      ];
      console.log(`\nGlobalPaySettlement ${settlement} (from block ${api.INDEXER_START_BLOCK ?? '?'})`);
      for (const [label, ok] of checks) console.log(`${tick(ok)} ${label}`);
      if (checks.some(([, ok]) => !ok)) steps.push('Fix the roles above: the keys in the two env files must match the deployment');
      if (!api.INDEXER_START_BLOCK || api.INDEXER_START_BLOCK === '0') steps.push('Run `npm run testnet -- record` to set INDEXER_START_BLOCK');
    }
  }
  console.log(steps.length ? `\nNext:\n${steps.map((s, i) => `  ${i + 1}. ${s}`).join('\n')}` : '\nReady: `npm run dev:testnet`, then `npm run testnet -- pay`.');
}

async function record(): Promise<void> {
  if (!existsSync(PATHS.broadcast)) throw new Error(`No broadcast record at ${show(PATHS.broadcast)}: deploy first`);
  const { address, block } = readDeployment(JSON.parse(readFileSync(PATHS.broadcast, 'utf8')));
  const api = readEnv(PATHS.apiEnv);
  const client = createPublicClient({ chain: baseSepolia, transport: http(api.RPC_URL) });
  const code = await client.getCode({ address });
  if (!code || code === '0x') throw new Error(`No contract at ${address} on Base Sepolia: was the deployment confirmed?`);

  let text = readFileSync(PATHS.apiEnv, 'utf8');
  text = setEnvValue(text, 'SETTLEMENT_ADDRESS', address);
  text = setEnvValue(text, 'INDEXER_START_BLOCK', block.toString());
  writeFileSync(PATHS.apiEnv, text, { mode: 0o600 });
  console.log(`Recorded GlobalPaySettlement ${address} (block ${block}) in ${show(PATHS.apiEnv)}.`);
  console.log(`Basescan: https://sepolia.basescan.org/address/${address}`);
}

async function pay(args: string[]): Promise<void> {
  const apiFlag = args.indexOf('--api');
  const base = apiFlag === -1 ? 'http://localhost:3000' : (args[apiFlag + 1] ?? '');
  const amountArg = args.find((a, i) => !a.startsWith('--') && i !== apiFlag + 1) ?? '100';
  const minor = parseDecimal(amountArg, FIAT_DECIMALS.THB);
  if (minor === null || minor <= 0n) throw new Error(`Not a valid THB amount: ${amountArg}`);
  const env = readEnv(PATHS.apiEnv);
  if (!env.E2E_PAYER_PRIVATE_KEY) throw new Error('E2E_PAYER_PRIVATE_KEY is missing from .env.base-sepolia');
  const payer = privateKeyToAccount(env.E2E_PAYER_PRIVATE_KEY as Hex);

  const call = async <T>(method: string, path: string, body?: unknown, token?: string): Promise<T> => {
    const response = await fetch(base + path, {
      method,
      headers: {
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const json = (await response.json().catch(() => ({}))) as T & { error?: string; message?: string };
    if (!response.ok) throw new Error(`${method} ${path}: ${response.status} ${json.error ?? ''} ${json.message ?? ''}`);
    return json;
  };

  const { message } = await call<{ message: string }>('POST', '/auth/nonce', { address: payer.address });
  const { token } = await call<{ token: string }>('POST', '/auth/verify', { message, signature: await payer.signMessage({ message }) });
  await call('POST', '/kyc/start', undefined, token);
  await call('GET', '/kyc/status', undefined, token);

  const qrPayload = buildPromptPayQr({
    kind: 'merchant',
    targetType: 'biller',
    targetId: '099999999999901',
    amount: { currency: 'THB', minor },
    merchantName: 'GLOBALPAY TEST CAFE',
  });
  type Typed = { domain: never; types: never; primaryType: never; message: Record<string, string> };
  const quote = await call<{ quote: { quoteId: Hex; tokenAmount: string }; authorizationToSign: Typed }>(
    'POST', '/quotes', { payer: payer.address, qrPayload }, token,
  );
  const typed = quote.authorizationToSign;
  console.log(`Quote ${quote.quote.quoteId}: ${formatUnits(BigInt(quote.quote.tokenAmount), 6)} USDC for ${amountArg} THB`);
  const signature = await payer.signTypedData(typed as never);
  let payment = await call<PaymentJson>('POST', '/payments', {
    quoteId: quote.quote.quoteId,
    validAfter: typed.message.validAfter,
    validBefore: typed.message.validBefore,
    signature,
  }, token);

  let last = '';
  const deadline = Date.now() + 5 * 60_000;
  for (;;) {
    const line = `${payment.status}${payment.payout ? ` · payout ${payment.payout.status}${payment.payout.reference ? ` ${payment.payout.reference}` : ''}` : ''}`;
    if (line !== last) console.log(`${new Date().toLocaleTimeString()}  ${line}`);
    last = line;
    if (['SETTLED', 'REFUNDED', 'FAILED'].includes(payment.status) || Date.now() > deadline) break;
    await new Promise((r) => setTimeout(r, 2_000));
    payment = await call<PaymentJson>('GET', `/payments/${payment.id}`, undefined, token);
  }
  for (const [name, tx] of Object.entries(payment.transactions)) console.log(`  ${name}: ${tx.url}`);
  if (payment.failureReason) console.log(`  reason: ${payment.failureReason}`);
}

interface PaymentJson {
  id: string;
  status: string;
  payout?: { status: string; reference?: string };
  transactions: Record<string, { url: string }>;
  failureReason?: string;
}

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);
  if (command === 'init') return init();
  if (command === 'status') return status();
  if (command === 'record') return record();
  if (command === 'pay') return pay(args);
  throw new Error('Usage: npm run testnet -- init | status | record | pay [THB] [--api URL]');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    console.error((error as Error).message);
    process.exit(1);
  });
}
