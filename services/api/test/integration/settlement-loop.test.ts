import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { type Abi, type AbiFunction, type Hex, createWalletClient, http } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { foundry } from 'viem/chains';
import { formatAbiItem } from 'viem/utils';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { settlementAbi } from '../../src/adapters/chain/abi.js';
import { ViemSettlementGateway } from '../../src/adapters/chain/viem-settlement-gateway.js';
import { createPrismaClient, createPrismaRepositories } from '../../src/adapters/db/prisma-repositories.js';
import { buildApp } from '../../src/app.js';
import { type Container, buildContainer } from '../../src/container.js';
import { buildPromptPayQr } from '../../src/lib/promptpay/build.js';
import type { Repositories } from '../../src/ports/repositories.js';
import { testEnv } from '../helpers.js';
import { ANVIL } from '../support/anvil.js';
import { createQuote, signAuthorization, signIn, signInVerified, submitPayment } from '../support/app.js';
import { createMemoryRepositories } from '../support/memory-repositories.js';
import { phoneKey } from '../support/phone-key.js';
import { type Anvil, CONTRACTS_DIR, deployLocal, findFoundryBin, startAnvil } from './foundry.js';

/**
 * The whole settlement loop against a real chain: anvil, the real contracts deployed by
 * contracts/script/DeployLocal.s.sol, and the real viem gateway and relayer. Only the payout
 * partner is simulated. Storage is in memory, or Postgres when TEST_DATABASE_URL is set.
 *
 * Skipped when Foundry isn't installed. See test/integration/foundry.ts for how it's found.
 */
const anvilBin = findFoundryBin('anvil');
const forgeBin = findFoundryBin('forge');

const PAYER_KEY = ANVIL.accounts.payer.privateKey;
const RELAYER_KEY: Hex = '0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6'; // anvil #3, operator
const TREASURY = ANVIL.accounts.treasury.address;

const qr = (minor: bigint) =>
  buildPromptPayQr({
    kind: 'merchant',
    targetType: 'biller',
    targetId: '099999999999901',
    amount: { currency: 'THB', minor },
    merchantName: 'GLOBALPAY TEST CAFE',
  });

describe.skipIf(!anvilBin || !forgeBin)('settlement loop on anvil', () => {
  let anvil: Anvil;
  const stacks: { app: FastifyInstance; container: Container }[] = [];
  const databases: { $disconnect(): Promise<void> }[] = [];

  beforeAll(async () => {
    anvil = await startAnvil(anvilBin!);
    deployLocal(forgeBin!, anvil.rpcUrl);
  }, 300_000);

  afterAll(async () => {
    for (const { app, container } of stacks) {
      await app.close();
      await container.close();
    }
    for (const prisma of databases) await prisma.$disconnect();
    anvil?.stop();
  });

  async function repositories(): Promise<Repositories> {
    const url = process.env.TEST_DATABASE_URL;
    if (!url) return createMemoryRepositories();
    // One connection: `prisma dev` (PGlite) mixes up concurrent connections. Real Postgres would not need it.
    const prisma = createPrismaClient(url, 1);
    databases.push(prisma);
    await prisma.$executeRawUnsafe(
      'TRUNCATE "PaymentRequest", "Device", "Deposit", "OnrampOrder", "OpsAction", "PayoutEvent", "Payout", "Payment", "Quote", "KycRecord", "SiweNonce", "User", "IndexerCursor" CASCADE',
    );
    return createPrismaRepositories(prisma);
  }

  /** The backend, as configured for a local chain. */
  async function stack(env: Record<string, string> = {}) {
    const container = buildContainer(
      testEnv({
        CHAIN_ID: String(ANVIL.chainId),
        RPC_URL: anvil.rpcUrl,
        CHAIN_POLL_MS: '100',
        USDC_ADDRESS: ANVIL.usdc,
        SETTLEMENT_ADDRESS: ANVIL.settlement,
        QUOTE_SIGNER_PRIVATE_KEY: ANVIL.accounts.quoteSigner.privateKey,
        RELAYER_PRIVATE_KEY: RELAYER_KEY,
        RATE_SOURCE: 'fixed',
        FIXED_USDC_THB_RATE: '33.00',
        INDEXER_CONFIRMATIONS: '0',
        PAYOUT_DELAY_MS: '0',
        PAYOUT_RECHECK_MS: '0',
        ...env,
      }),
      { repositories: await repositories() },
    );
    const app = await buildApp({ container, logger: false });
    stacks.push({ app, container });
    // Read-only view of the chain for the assertions (no relayer key).
    const reader = new ViemSettlementGateway({
      rpcUrl: anvil.rpcUrl,
      chainId: ANVIL.chainId,
      settlementAddress: ANVIL.settlement,
    });
    const balance = (owner: Hex) => reader.getTokenBalance(ANVIL.usdc, owner);

    /** Runs the indexer and payout worker until the payment is final. */
    async function drive(paymentId: string, session: { auth: { authorization: string } }) {
      for (let i = 0; i < 10; i++) {
        await container.workers.indexer.tick();
        await container.workers.payouts.tick();
        const payment = (await app.inject({ method: 'GET', url: `/payments/${paymentId}`, headers: session.auth })).json();
        if (['SETTLED', 'REFUNDED', 'FAILED'].includes(payment.status)) return payment;
      }
      throw new Error(`payment ${paymentId} did not finish`);
    }

    return { app, container, reader, balance, drive };
  }

  async function payQuote(app: FastifyInstance, session: Awaited<ReturnType<typeof signInVerified>>, key: Hex, minor: bigint) {
    const quote = await createQuote(app, session, qr(minor));
    const response = await submitPayment(app, session, quote, await signAuthorization(key, quote));
    return { quote, response };
  }

  it('settles: the merchant is paid and the USDC goes to the treasury', async () => {
    const { app, reader, balance, drive } = await stack();
    const session = await signInVerified(app, PAYER_KEY);
    const before = { payer: await balance(session.address), treasury: await balance(TREASURY) };

    const { quote, response } = await payQuote(app, session, PAYER_KEY, 250_00n);
    expect(response.statusCode).toBe(202);
    expect(response.json().status).toBe('SUBMITTED');

    const payment = await drive(response.json().id, session);
    expect(payment).toMatchObject({ status: 'SETTLED', fiatAmount: '25000', tokenAmount: quote.quote.tokenAmount });
    expect(payment.transactions.pay.hash).toMatch(/^0x/);
    expect(payment.transactions.settle.hash).toMatch(/^0x/);

    const amount = BigInt(quote.quote.tokenAmount);
    expect(await balance(session.address)).toBe(before.payer - amount);
    expect(await balance(TREASURY)).toBe(before.treasury + amount);
    expect(await reader.getPaymentStatus(quote.quote.quoteId)).toBe('Settled');
  }, 60_000);

  it('refunds: a failed payout returns the USDC to the payer', async () => {
    const { app, reader, balance, drive } = await stack({ PAYOUT_FAILURE_RATE: '1' });
    const session = await signInVerified(app, PAYER_KEY);
    const before = { payer: await balance(session.address), treasury: await balance(TREASURY) };

    const { quote, response } = await payQuote(app, session, PAYER_KEY, 99_00n);
    const payment = await drive(response.json().id, session);

    expect(payment).toMatchObject({
      status: 'REFUNDED',
      failureReason: 'Simulated payout failure (PAYOUT_FAILURE_RATE)',
    });
    expect(payment.transactions.refund.hash).toMatch(/^0x/);
    expect(await balance(session.address)).toBe(before.payer);
    expect(await balance(TREASURY)).toBe(before.treasury);
    expect(await reader.getPaymentStatus(quote.quote.quoteId)).toBe('Refunded');
  }, 60_000);

  it('holds an unclear payout until an operator confirms it, then settles', async () => {
    const opsToken = 'integration-ops-token-0123456789abcdef';
    const { app, container, reader, balance } = await stack({ PAYOUT_UNKNOWN_RATE: '1', OPS_API_TOKEN: opsToken });
    const session = await signInVerified(app, PAYER_KEY);
    const before = { treasury: await balance(TREASURY) };
    const { quote, response } = await payQuote(app, session, PAYER_KEY, 120_00n);
    const id: string = response.json().id;
    const get = async () => (await app.inject({ method: 'GET', url: `/payments/${id}`, headers: session.auth })).json();

    for (let i = 0; i < 5; i++) {
      await container.workers.indexer.tick();
      await container.workers.payouts.tick();
    }
    // Neither settled nor refunded: the USDC waits in the contract.
    expect(await get()).toMatchObject({ status: 'PAYOUT_PENDING', payout: { status: 'UNKNOWN' } });
    expect(await reader.getPaymentStatus(quote.quote.quoteId)).toBe('Paid');

    const ops = { 'x-ops-token': opsToken };
    const exceptions = (await app.inject({ method: 'GET', url: '/ops/api/exceptions', headers: ops })).json();
    expect(exceptions.items).toEqual([expect.objectContaining({ kind: 'payout_unknown', paymentId: id })]);
    const marked = await app.inject({
      method: 'POST',
      url: `/ops/api/payouts/${id}/mark-paid`,
      headers: ops,
      payload: { actor: 'integration', note: 'Partner support confirmed', reference: 'KBANK-INT-0001' },
    });
    expect(marked.statusCode).toBe(200);

    await container.workers.payouts.tick();
    expect(await get()).toMatchObject({
      status: 'SETTLED',
      payout: { status: 'SUCCEEDED', reference: 'KBANK-INT-0001' },
    });
    expect(await reader.getPaymentStatus(quote.quote.quoteId)).toBe('Settled');
    expect(await balance(TREASURY)).toBe(before.treasury + BigInt(quote.quote.tokenAmount));
  }, 60_000);

  it('adds money: the simulated onramp mints test USDC, proved on-chain and found as a deposit', async () => {
    const { app, container, balance } = await stack();
    const session = await signIn(app, generatePrivateKey());
    const created = await app.inject({ method: 'POST', url: '/onramp/orders', headers: session.auth, payload: { fiatAmountMinor: '80000' } });
    expect(created.statusCode).toBe(201);
    const { order, checkoutUrl } = created.json();

    const form = { 'content-type': 'application/x-www-form-urlencoded' };
    expect((await app.inject({ method: 'POST', url: `${checkoutUrl}/pay`, headers: form, payload: '' })).statusCode).toBe(303);

    // 800 THB at 33.00 THB/USDC, minted to the user's wallet and checked through the real token reader.
    const done = (await app.inject({ method: 'GET', url: `/onramp/orders/${order.id}`, headers: session.auth })).json();
    expect(done).toMatchObject({ status: 'COMPLETED', tokenAmount: '24242424' });
    expect(await balance(session.address)).toBe(24_242_424n);

    await container.workers.deposits.tick();
    const deposits = (await app.inject({ method: 'GET', url: '/me/deposits', headers: session.auth })).json().deposits;
    expect(deposits).toEqual([expect.objectContaining({ amount: '24242424', onrampOrderId: order.id })]);
  }, 60_000);

  it('tap to pay: a tap identifies the sender, whose signed transfer is relayed to the receiver', async () => {
    const { app, container, balance } = await stack();
    const receiver = await signInVerified(app, generatePrivateKey());
    const sender = await signInVerified(app, PAYER_KEY);
    const before = { sender: await balance(sender.address), receiver: await balance(receiver.address) };
    const inject = (method: 'GET' | 'POST', url: string, who: { auth: { authorization: string } }, payload?: object) =>
      app.inject({ method, url, headers: who.auth, ...(payload ? { payload } : {}) });

    const phone = phoneKey();
    const device = (await inject('POST', '/devices', sender, { publicKey: phone.publicKey, platform: 'android' })).json();
    const request = (await inject('POST', '/p2p/requests', receiver, { amount: '3000000' })).json();
    const tapped = await inject('POST', `/p2p/requests/${request.id}/tap`, receiver, { deviceId: device.id, signature: phone.signTap(request.challenge) });
    expect(tapped.json().status).toBe('SENDER_IDENTIFIED');

    // Signed against the real token's EIP-712 domain, relayed through the real relayer.
    const typed = (await inject('GET', `/p2p/requests/${request.id}/authorization`, sender)).json();
    const signature = await privateKeyToAccount(PAYER_KEY).signTypedData(typed);
    const approved = await inject('POST', `/p2p/requests/${request.id}/approve`, sender, { signature });
    expect(approved.json().status).toBe('SUBMITTED');

    await container.workers.p2p.tick();
    expect((await inject('GET', `/p2p/requests/${request.id}`, receiver)).json().status).toBe('COMPLETED');
    expect(await balance(receiver.address)).toBe(before.receiver + 3_000_000n);
    expect(await balance(sender.address)).toBe(before.sender - 3_000_000n);

    // The same approval can't be used twice.
    expect((await inject('POST', `/p2p/requests/${request.id}/approve`, sender, { signature })).statusCode).toBe(409);
  }, 60_000);

  it('rejects a payment the contract would revert, without sending it', async () => {
    const { app } = await stack();
    const brokeKey = generatePrivateKey(); // no USDC
    const session = await signInVerified(app, brokeKey);

    const { response } = await payQuote(app, session, brokeKey, 10_00n);
    expect(response.statusCode).toBe(422);
    expect(response.json()).toMatchObject({
      error: 'payment_rejected',
      message: 'The payment would fail on-chain: ERC20InsufficientBalance',
    });
  }, 60_000);

  it('sends concurrent payments with correct nonces, and recovers when the key is used elsewhere', async () => {
    const { app, drive } = await stack();
    const session = await signInVerified(app, PAYER_KEY);

    const [first, second] = await Promise.all([
      payQuote(app, session, PAYER_KEY, 10_00n),
      payQuote(app, session, PAYER_KEY, 20_00n),
    ]);
    expect(first.response.statusCode).toBe(202);
    expect(second.response.statusCode).toBe(202);

    // Another process sends from the relayer key, so the relayer's cached nonce goes stale.
    const relayerWallet = createWalletClient({
      account: privateKeyToAccount(RELAYER_KEY),
      chain: foundry,
      transport: http(anvil.rpcUrl),
    });
    await relayerWallet.sendTransaction({ to: TREASURY, value: 0n });

    const results = await Promise.all([drive(first.response.json().id, session), drive(second.response.json().id, session)]);
    expect(results.map((p) => p.status)).toEqual(['SETTLED', 'SETTLED']);
  }, 60_000);

  it("uses an ABI that matches the compiled contract", () => {
    const artifact = JSON.parse(
      readFileSync(join(CONTRACTS_DIR, 'out/GlobalPaySettlement.sol/GlobalPaySettlement.json'), 'utf8'),
    ) as { abi: Abi };
    const signature = (item: Abi[number]) =>
      item.type === 'function'
        ? `${formatAbiItem(item)} returns (${(item as AbiFunction).outputs.map((o) => o.type).join(',')})`
        : formatAbiItem(item);
    const comparable = (item: Abi[number]) => ['function', 'event', 'error'].includes(item.type);
    const compiled = new Set(artifact.abi.filter(comparable).map(signature));
    // Raised by the token, not the settlement contract: they're in our ABI only to decode reverts.
    const tokenErrors = new Set([
      'ERC20InsufficientBalance',
      'CallerMustBePayee',
      'AuthorizationNotYetValid',
      'AuthorizationExpired',
      'AuthorizationAlreadyUsed',
      'InvalidAuthorizationSignature',
    ]);

    const ours = settlementAbi.filter((item) => !(item.type === 'error' && tokenErrors.has(item.name)));
    const missing = ours.map(signature).filter((s) => !compiled.has(s));
    expect(missing).toEqual([]);
  });
});
