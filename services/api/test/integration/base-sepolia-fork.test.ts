import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { type Address, type Hex, createPublicClient, createWalletClient, erc20Abi, http, parseAbi, parseEther, toHex } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { baseSepolia } from 'viem/chains';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readDeployment } from '../../scripts/testnet.js';
import { buildApp } from '../../src/app.js';
import { type Container, buildContainer } from '../../src/container.js';
import { buildPromptPayQr } from '../../src/lib/promptpay/build.js';
import { testEnv } from '../helpers.js';
import { createQuote, signAuthorization, signInVerified, submitPayment } from '../support/app.js';
import { createMemoryRepositories } from '../support/memory-repositories.js';
import { type Anvil, deployScript, findFoundryBin, startAnvil } from './foundry.js';

/**
 * A dress rehearsal of the Base Sepolia deployment, on a local fork of Base Sepolia:
 * - the real contracts/script/Deploy.s.sol, with freshly generated keys (as `npm run testnet -- init` makes);
 * - Circle's real test USDC (FiatToken), minted to the payer by impersonating its master minter;
 * - the real backend: quote, gasless pay(), indexer, payout, markSettled or refund.
 *
 * Needs Foundry and network access, so it runs only when BASE_SEPOLIA_FORK_URL is set, e.g.
 *   BASE_SEPOLIA_FORK_URL=https://sepolia.base.org npx vitest run test/integration/base-sepolia-fork.test.ts
 */
const forkUrl = process.env.BASE_SEPOLIA_FORK_URL;
const anvilBin = findFoundryBin('anvil');
const forgeBin = findFoundryBin('forge');

const USDC: Address = '0x036CbD53842c5426634e7929541eC2318f3dCF7e';
const fiatTokenAbi = parseAbi([
  'function masterMinter() view returns (address)',
  'function configureMinter(address minter, uint256 minterAllowedAmount) returns (bool)',
  'function mint(address to, uint256 amount) returns (bool)',
]);

// Fresh keys: well-known test accounts may carry code on public testnets, which changes how USDC
// checks their signatures.
const keys = {
  deployer: generatePrivateKey(),
  quoteSigner: generatePrivateKey(),
  relayer: generatePrivateKey(),
  treasury: generatePrivateKey(),
  payer: generatePrivateKey(),
};
const address = (key: Hex) => privateKeyToAccount(key).address;

describe.skipIf(!anvilBin || !forgeBin || !forkUrl)('Base Sepolia rehearsal on a fork', () => {
  let anvil: Anvil;
  let settlement: Address;
  let startBlock: bigint;
  const broadcastDir = mkdtempSync(join(tmpdir(), 'globalpay-fork-'));
  const stacks: { app: FastifyInstance; container: Container }[] = [];

  const rpc = async (method: string, params: unknown[]) => {
    const response = await fetch(anvil.rpcUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    });
    const json = (await response.json()) as { error?: { message: string } };
    if (json.error) throw new Error(`${method}: ${json.error.message}`);
  };
  const client = () => createPublicClient({ chain: baseSepolia, transport: http(anvil.rpcUrl) });
  const usdcOf = (owner: Address) => client().readContract({ address: USDC, abi: erc20Abi, functionName: 'balanceOf', args: [owner] });

  /** Sends a transaction as `from` without its key (anvil impersonation). */
  async function as(from: Address, functionName: 'configureMinter' | 'mint', args: readonly [Address, bigint]) {
    await rpc('anvil_impersonateAccount', [from]);
    await rpc('anvil_setBalance', [from, toHex(parseEther('1'))]);
    const wallet = createWalletClient({ account: from, chain: baseSepolia, transport: http(anvil.rpcUrl) });
    const hash = await wallet.writeContract({ address: USDC, abi: fiatTokenAbi, functionName, args });
    const receipt = await client().waitForTransactionReceipt({ hash });
    expect(receipt.status).toBe('success');
  }

  beforeAll(async () => {
    anvil = await startAnvil(anvilBin!, ['--fork-url', forkUrl!, '--chain-id', String(baseSepolia.id)]);
    for (const key of [keys.deployer, keys.relayer]) await rpc('anvil_setBalance', [address(key), toHex(parseEther('0.05'))]);
    startBlock = await client().getBlockNumber();

    const output = deployScript(
      forgeBin!,
      anvil.rpcUrl,
      {
        DEPLOYER_PRIVATE_KEY: keys.deployer,
        TREASURY_ADDRESS: address(keys.treasury),
        QUOTE_SIGNER_ADDRESS: address(keys.quoteSigner),
        OPERATOR_ADDRESS: address(keys.relayer),
        PAUSER_ADDRESS: address(keys.deployer),
        USDC_ADDRESS: USDC,
      },
      broadcastDir,
    );
    const record = JSON.parse(readFileSync(join(broadcastDir, 'Deploy.s.sol', String(baseSepolia.id), 'run-latest.json'), 'utf8'));
    const deployment = readDeployment(record);
    settlement = deployment.address;
    expect(output).toContain(`GlobalPaySettlement: ${settlement}`);
    expect(deployment.block).toBeGreaterThan(startBlock);

    // Test USDC for the payer, the way Circle mints it.
    const masterMinter = await client().readContract({ address: USDC, abi: fiatTokenAbi, functionName: 'masterMinter' });
    const minter = address(generatePrivateKey());
    await as(masterMinter, 'configureMinter', [minter, 1_000_000_000n]);
    await as(minter, 'mint', [address(keys.payer), 100_000_000n]);
  }, 600_000);

  afterAll(async () => {
    for (const { app, container } of stacks) {
      await app.close();
      await container.close();
    }
    anvil?.stop();
    rmSync(broadcastDir, { recursive: true, force: true });
  });

  /** The backend configured as for Base Sepolia, pointed at the fork. */
  async function stack(env: Record<string, string> = {}) {
    const container = buildContainer(
      testEnv({
        CHAIN_ID: String(baseSepolia.id),
        RPC_URL: anvil.rpcUrl,
        CHAIN_POLL_MS: '200',
        USDC_ADDRESS: USDC,
        SETTLEMENT_ADDRESS: settlement,
        QUOTE_SIGNER_PRIVATE_KEY: keys.quoteSigner,
        RELAYER_PRIVATE_KEY: keys.relayer,
        RATE_SOURCE: 'fixed',
        FIXED_USDC_THB_RATE: '33.00',
        INDEXER_CONFIRMATIONS: '0',
        INDEXER_START_BLOCK: startBlock.toString(),
        PAYOUT_DELAY_MS: '0',
        PAYOUT_RECHECK_MS: '0',
        ...env,
      }),
      { repositories: createMemoryRepositories() },
    );
    const app = await buildApp({ container, logger: false });
    stacks.push({ app, container });
    const session = await signInVerified(app, keys.payer);

    async function payAndFinish(minor: bigint) {
      const qr = buildPromptPayQr({ kind: 'merchant', targetType: 'biller', targetId: '099999999999901', amount: { currency: 'THB', minor } });
      const quote = await createQuote(app, session, qr);
      const submitted = await submitPayment(app, session, quote, await signAuthorization(keys.payer, quote));
      expect(submitted.statusCode).toBe(202);
      const id: string = submitted.json().id;
      for (let i = 0; i < 15; i++) {
        await container.workers.indexer.tick();
        await container.workers.payouts.tick();
        const payment = (await app.inject({ method: 'GET', url: `/payments/${id}`, headers: session.auth })).json();
        if (['SETTLED', 'REFUNDED', 'FAILED'].includes(payment.status)) return { payment, quote };
      }
      throw new Error(`payment ${id} did not finish`);
    }
    return { payAndFinish };
  }

  it('reads the USDC domain from the chain and settles a payment in Circle test USDC', async () => {
    const { payAndFinish } = await stack();
    const before = { payer: await usdcOf(address(keys.payer)), treasury: await usdcOf(address(keys.treasury)) };

    const { payment, quote } = await payAndFinish(100_00n);
    expect(quote.authorizationToSign.domain).toMatchObject({ name: 'USDC', version: '2', chainId: 84532, verifyingContract: USDC });
    expect(payment).toMatchObject({ status: 'SETTLED', payout: { status: 'SUCCEEDED' } });
    expect(payment.transactions.settle.url).toMatch(/^https:\/\/sepolia\.basescan\.org\/tx\/0x/);

    const amount = BigInt(quote.quote.tokenAmount);
    expect(await usdcOf(address(keys.payer))).toBe(before.payer - amount);
    expect(await usdcOf(address(keys.treasury))).toBe(before.treasury + amount);
  }, 120_000);

  it('refunds the payer in Circle test USDC when the payout fails', async () => {
    const { payAndFinish } = await stack({ PAYOUT_FAILURE_RATE: '1' });
    const before = await usdcOf(address(keys.payer));
    const { payment } = await payAndFinish(50_00n);
    expect(payment).toMatchObject({ status: 'REFUNDED', payout: { status: 'FAILED' } });
    expect(await usdcOf(address(keys.payer))).toBe(before);
  }, 120_000);
});
