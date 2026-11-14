import { type Hex, keccak256, toHex } from 'viem';
import { afterEach, describe, expect, it } from 'vitest';
import { SimulatedPromptPayProvider } from '../src/adapters/payouts/simulated-promptpay-provider.js';
import { buildPromptPayQr } from '../src/lib/promptpay/build.js';
import { IndexerWorker } from '../src/workers/indexer.js';
import type { WorkerLogger } from '../src/workers/loop.js';
import { PayoutWorker } from '../src/workers/payout-worker.js';
import { TransactionRejectedError } from '../src/ports/settlement-gateway.js';
import { ANVIL } from './support/anvil.js';
import {
  type TestApp,
  buildTestApp,
  createQuote,
  signAuthorization,
  signInVerified,
  submitPayment,
} from './support/app.js';

const PAYER_KEY = ANVIL.accounts.payer.privateKey;
const qr = buildPromptPayQr({
  kind: 'merchant',
  targetType: 'biller',
  targetId: '099999999999901',
  amount: { currency: 'THB', minor: 100_00n },
});

let testApp: TestApp | undefined;

afterEach(async () => {
  await testApp?.app.close();
  testApp = undefined;
});

async function setup(env: Record<string, string> = {}) {
  testApp = await buildTestApp({
    env: { INDEXER_CONFIRMATIONS: '0', PAYOUT_DELAY_MS: '0', PAYOUT_FAILURE_RATE: '0', ...env },
  });
  const session = await signInVerified(testApp.app, PAYER_KEY);
  const { indexer, payouts } = testApp.container.workers;

  /** Quotes and submits a payment; returns its ID and quote ID. */
  async function pay(): Promise<{ id: string; quoteId: Hex }> {
    const quote = await createQuote(testApp!.app, session, qr);
    const response = await submitPayment(testApp!.app, session, quote, await signAuthorization(PAYER_KEY, quote));
    return { id: response.json().id, quoteId: quote.quote.quoteId };
  }
  const status = (id: string) => testApp!.repos.state.payments.get(id)?.status;
  return { ...testApp, session, indexer, payouts, pay, status };
}

function recordingLogger() {
  const lines: { level: string; message: string }[] = [];
  const logger: WorkerLogger = {
    info: (_obj: unknown, message?: string) => void lines.push({ level: 'info', message: message ?? '' }),
    warn: (_obj: unknown, message?: string) => void lines.push({ level: 'warn', message: message ?? '' }),
    error: (_obj: unknown, message?: string) => void lines.push({ level: 'error', message: message ?? '' }),
  } as WorkerLogger;
  return { logger, lines };
}

describe('indexer', () => {
  it('marks a payment PAID once its event has enough confirmations', async () => {
    const { chain, indexer, repos, pay, status } = await setup({ INDEXER_CONFIRMATIONS: '2' });
    const { id } = await pay();

    await indexer.tick();
    expect(status(id)).toBe('SUBMITTED');

    chain.advance(2n);
    await indexer.tick();
    expect(status(id)).toBe('PAID');
    expect(repos.state.payments.get(id)?.paidBlock).toBe(chain.events[0]?.blockNumber);
    expect([...repos.state.cursors.values()]).toEqual([chain.block - 2n]);
  });

  it('ignores events it has already processed', async () => {
    const { indexer, repos, pay, status } = await setup();
    const { id } = await pay();
    await indexer.tick();
    expect(status(id)).toBe('PAID');

    repos.state.cursors.clear(); // e.g. a restart with a lost cursor
    await indexer.tick();
    expect(status(id)).toBe('PAID');
  });

  it('warns when a public chain would be scanned from block 0', async () => {
    const { chain, repos } = await setup();
    const make = (chainId: number, startBlock: bigint) =>
      new IndexerWorker({
        gateway: chain,
        payments: repos.payments,
        quotes: repos.quotes,
        cursors: repos.cursors,
        chainId,
        settlementAddress: ANVIL.settlement,
        pollMs: 60_000,
        confirmations: 0,
        startBlock,
      });
    for (const [chainId, startBlock, warned] of [[84532, 0n, true], [84532, 58_000_000n, false], [31337, 0n, false]] as const) {
      const { logger, lines } = recordingLogger();
      const worker = make(chainId, startBlock);
      worker.start(logger);
      await worker.stop();
      expect(lines.some((l) => l.message.includes('INDEXER_START_BLOCK is 0'))).toBe(warned);
    }
  });

  it('reads long block ranges in chunks', async () => {
    const { chain, repos, pay, status } = await setup();
    const { id } = await pay();
    const queried: [bigint, bigint][] = [];
    const getEvents = chain.getPaymentReceivedEvents.bind(chain);
    chain.getPaymentReceivedEvents = async (from, to) => {
      queried.push([from, to]);
      return getEvents(from, to);
    };
    const indexer = new IndexerWorker({
      gateway: chain,
      payments: repos.payments,
      quotes: repos.quotes,
      cursors: repos.cursors,
      chainId: ANVIL.chainId,
      settlementAddress: ANVIL.settlement,
      pollMs: 1_000,
      confirmations: 0,
      startBlock: 0n,
      maxBlockRange: 40n,
    });

    await indexer.tick();
    expect(queried[0]).toEqual([0n, 39n]);
    expect(queried.at(-1)?.[1]).toBe(chain.block);
    expect(status(id)).toBe('PAID');
  });

  it("tracks a payment someone else submitted, and skips quotes it doesn't know", async () => {
    const { app, chain, indexer, repos, session } = await setup();
    const quote = await createQuote(app, session, qr);
    const stored = repos.state.quotes.get(quote.quote.quoteId);
    if (!stored) throw new Error('quote not stored');
    await chain.submitPayment(stored, { validAfter: 0n, validBefore: 0n, signature: '0x' });
    chain.events.push({ ...chain.events[0]!, quoteId: keccak256(toHex('not ours')) });

    const { logger, lines } = recordingLogger();
    indexer.start(logger);
    await indexer.stop();
    await indexer.tick();

    const [payment] = [...repos.state.payments.values()];
    expect(payment).toMatchObject({ quoteId: quote.quote.quoteId, status: 'PAID', userId: session.userId });
    expect(lines).toContainEqual({ level: 'warn', message: 'PaymentReceived for an unknown quote' });
  });

  it('fails a payment whose pay() reverted', async () => {
    const { chain, indexer, repos, pay, status } = await setup();
    chain.revertNextWrite = true;
    const { id } = await pay();

    await indexer.tick();
    expect(status(id)).toBe('FAILED');
    expect(repos.state.payments.get(id)?.failureReason).toBe('The pay() transaction reverted');
  });

  it("fails a payment that didn't land before its quote expired, but not before", async () => {
    const { chain, indexer, repos, pay, status } = await setup();
    chain.autoMine = false;
    const { id, quoteId } = await pay();

    await indexer.tick();
    expect(status(id)).toBe('SUBMITTED');

    repos.state.quotes.get(quoteId)!.quote.expiresAt = new Date(Date.now() - 61_000);
    await indexer.tick();
    expect(status(id)).toBe('FAILED');
    expect(repos.state.payments.get(id)?.failureReason).toBe('pay() was not mined before the quote expired');
  });

  it('leaves an expired payment alone if it did land on-chain', async () => {
    const { chain, indexer, repos, pay, status } = await setup({ INDEXER_CONFIRMATIONS: '5' });
    const { id, quoteId } = await pay();
    repos.state.quotes.get(quoteId)!.quote.expiresAt = new Date(Date.now() - 61_000);

    await indexer.tick(); // mined but not yet confirmed
    expect(status(id)).toBe('SUBMITTED');
    chain.advance(5n);
    await indexer.tick();
    expect(status(id)).toBe('PAID');
  });
});

describe('payout worker', () => {
  async function runUntilFinal(worker: { tick(): Promise<void> }, read: () => string | undefined, max = 5) {
    for (let i = 0; i < max && !['SETTLED', 'REFUNDED', 'FAILED'].includes(read() ?? ''); i++) await worker.tick();
    return read();
  }

  it('pays out, then settles on-chain', async () => {
    const { chain, indexer, payouts, repos, pay, status } = await setup();
    const { id, quoteId } = await pay();
    await indexer.tick();

    await payouts.tick();
    expect(status(id)).toBe('PAYOUT_PENDING');
    expect(await runUntilFinal(payouts, () => status(id))).toBe('SETTLED');

    expect(chain.onChain.get(quoteId)?.status).toBe('Settled');
    const payment = repos.state.payments.get(id);
    expect(payment?.settleTxHash).toBe(chain.sent.find((s) => s.functionName === 'markSettled')?.hash);
    expect(repos.state.payouts.get(id)).toMatchObject({
      status: 'SUCCEEDED',
      provider: 'simulated-promptpay',
      attempts: 1,
      amount: { currency: 'THB', minor: 100_00n },
    });
  });

  it('refunds on-chain when the payout fails', async () => {
    const { chain, indexer, payouts, repos, pay, status } = await setup({ PAYOUT_FAILURE_RATE: '1' });
    const { id, quoteId } = await pay();
    await indexer.tick();

    expect(await runUntilFinal(payouts, () => status(id))).toBe('REFUNDED');
    expect(chain.onChain.get(quoteId)?.status).toBe('Refunded');
    expect(repos.state.payments.get(id)).toMatchObject({
      failureReason: 'Simulated payout failure (PAYOUT_FAILURE_RATE)',
    });
    expect(repos.state.payments.get(id)?.refundTxHash).toMatch(/^0x/);
  });

  it('waits while the partner is still paying', async () => {
    const { indexer, payouts, pay, status } = await setup({ PAYOUT_DELAY_MS: '60000' });
    const { id } = await pay();
    await indexer.tick();
    for (let i = 0; i < 3; i++) await payouts.tick();
    expect(status(id)).toBe('PAYOUT_PENDING');
  });

  it('finishes without a new transaction if the chain already shows it settled', async () => {
    const { chain, indexer, payouts, pay, status } = await setup();
    const { id, quoteId } = await pay();
    await indexer.tick();
    await payouts.tick(); // payout created
    await chain.markSettled(quoteId); // as if an earlier run sent it, then crashed
    const sentBefore = chain.sent.length;

    expect(await runUntilFinal(payouts, () => status(id))).toBe('SETTLED');
    expect(chain.sent).toHaveLength(sentBefore);
  });

  it('records a pending settlement and completes it once mined', async () => {
    const { chain, indexer, payouts, repos, pay, status } = await setup();
    const { id } = await pay();
    await indexer.tick();
    await payouts.tick();
    chain.autoMine = false;

    await payouts.tick(); // sends markSettled; the receipt wait fails
    expect(status(id)).toBe('PAYOUT_PENDING');
    expect(repos.state.payments.get(id)?.settleTxHash).toMatch(/^0x/);

    await payouts.tick(); // still pending: no second transaction
    expect(chain.sent.filter((s) => s.functionName === 'markSettled')).toHaveLength(1);

    chain.mine();
    await payouts.tick();
    expect(status(id)).toBe('SETTLED');
  });

  it("keeps going when one payment's step fails", async () => {
    const { chain, indexer, payouts, pay, status } = await setup();
    const first = await pay();
    const second = await pay();
    await indexer.tick();
    await payouts.tick();

    chain.failNextWrite = new TransactionRejectedError('EnforcedPause');
    await payouts.tick();
    expect(status(first.id)).toBe('PAYOUT_PENDING');
    expect(status(second.id)).toBe('SETTLED');

    await payouts.tick();
    expect(status(first.id)).toBe('SETTLED');
  });

  it('never settles or refunds while the payout outcome is unclear', async () => {
    const { chain, indexer, payouts, repos, pay, status } = await setup({ PAYOUT_UNKNOWN_RATE: '1' });
    const { id } = await pay();
    await indexer.tick();

    for (let i = 0; i < 5; i++) await payouts.tick();
    expect(status(id)).toBe('PAYOUT_PENDING');
    expect(repos.state.payouts.get(id)).toMatchObject({
      status: 'UNKNOWN',
      lastError: 'Simulated unclear outcome (PAYOUT_UNKNOWN_RATE)',
    });
    expect(repos.state.payouts.get(id)?.unknownSince).toBeInstanceOf(Date);
    expect(chain.sent.filter((s) => s.functionName !== 'pay')).toHaveLength(0);
  });

  it('records the settlement error on the payout for operators', async () => {
    const { chain, indexer, payouts, repos, pay } = await setup();
    const { id } = await pay();
    await indexer.tick();
    await payouts.tick();
    chain.failNextWrite = new TransactionRejectedError('EnforcedPause');
    await payouts.tick();
    expect(repos.state.payouts.get(id)?.lastError).toMatch(/EnforcedPause/);
  });

  /** A payout worker that looks at `batchSize` payout-pending payments per tick. */
  function smallBatchWorker(t: Awaited<ReturnType<typeof setup>>, batchSize: number) {
    return new PayoutWorker({
      payments: t.repos.payments,
      payouts: t.repos.payouts,
      tracker: t.container.services.payouts,
      gateway: t.chain,
      pollMs: 60_000,
      enabled: true,
      batchSize,
    });
  }

  it('keeps payouts waiting out a partner outage from holding up newer payments', async () => {
    const t = await setup();
    const worker = smallBatchWorker(t, 2);
    const stuck = [await t.pay(), await t.pay()];
    await t.indexer.tick();
    // After a partner outage, both payouts are UNKNOWN and waiting out their backoff.
    for (const { id } of stuck) {
      await t.repos.payments.transition(id, 'PAID', 'PAYOUT_PENDING');
      await t.container.services.payouts.ensurePayout((await t.repos.payments.findById(id))!);
      await t.repos.payouts.transition(id, 'PENDING', 'UNKNOWN', {
        unknownSince: new Date(),
        nextCheckAt: new Date(Date.now() + 60 * 60_000),
        lastError: 'Partner timed out',
      });
    }

    const fresh = await t.pay();
    await t.indexer.tick();
    expect(await runUntilFinal(worker, () => t.status(fresh.id))).toBe('SETTLED');
    expect(stuck.map(({ id }) => t.status(id))).toEqual(['PAYOUT_PENDING', 'PAYOUT_PENDING']);
  });

  it("takes turns, so payments it can't resolve don't hold up the rest", async () => {
    const t = await setup();
    const worker = smallBatchWorker(t, 2);
    const stuck = [await t.pay(), await t.pay()];
    await t.indexer.tick();
    await t.payouts.tick(); // both payouts sent; the next check finds them SUCCEEDED
    // But the chain has no payment to settle (e.g. it was made on an older contract).
    for (const { quoteId } of stuck) t.chain.onChain.delete(quoteId);

    const fresh = await t.pay();
    await t.indexer.tick();
    expect(await runUntilFinal(worker, () => t.status(fresh.id), 8)).toBe('SETTLED');
    expect(stuck.map(({ id }) => t.status(id))).toEqual(['PAYOUT_PENDING', 'PAYOUT_PENDING']);
  });

  it('does nothing if the chain shows no payment to settle', async () => {
    const { chain, indexer, payouts, pay, status } = await setup();
    const { id, quoteId } = await pay();
    await indexer.tick();
    chain.onChain.delete(quoteId);

    for (let i = 0; i < 3; i++) await payouts.tick();
    expect(status(id)).toBe('PAYOUT_PENDING');
    expect(chain.sent.filter((s) => s.functionName !== 'pay')).toHaveLength(0);
  });
});

describe('SimulatedPromptPayProvider', () => {
  const request = {
    idempotencyKey: 'payment_1',
    paymentId: 'payment_1',
    merchant: { raw: '', initiation: 'dynamic', kind: 'merchant', targetType: 'biller', targetId: '1' },
    amount: { currency: 'THB', minor: 100n },
  } as const;

  it('is idempotent per payment and resolves after the delay', async () => {
    let now = 1_000_000;
    const provider = new SimulatedPromptPayProvider({ delayMs: 3_000, failureRate: 0, now: () => now });
    const first = await provider.createPayout(request);
    const again = await provider.createPayout(request);
    expect(again).toEqual(first);
    expect(first.status).toBe('pending');

    now += 2_999;
    await expect(provider.getPayout(first.providerRef!)).resolves.toMatchObject({ status: 'pending' });
    now += 1;
    await expect(provider.getPayout(first.providerRef!)).resolves.toMatchObject({ status: 'succeeded' });
  });

  it('decides failures by payment ID, so a restart gives the same answer', async () => {
    const outcomes = async (rate: number) => {
      const provider = new SimulatedPromptPayProvider({ delayMs: 0, failureRate: rate });
      const results = [];
      for (let i = 0; i < 200; i++) {
        const { providerRef } = await provider.createPayout({ ...request, paymentId: `p${i}`, idempotencyKey: `p${i}` });
        results.push((await provider.getPayout(providerRef!)).status);
      }
      return results;
    };
    expect(new Set(await outcomes(0))).toEqual(new Set(['succeeded']));
    expect(new Set(await outcomes(1))).toEqual(new Set(['failed']));
    const half = await outcomes(0.5);
    expect(half).toEqual(await outcomes(0.5));
    const failed = half.filter((s) => s === 'failed').length;
    expect(failed).toBeGreaterThan(60);
    expect(failed).toBeLessThan(140);
  });

  it("treats a reference it doesn't know as unknown, never as failed", async () => {
    const provider = new SimulatedPromptPayProvider({ delayMs: 0, failureRate: 0 });
    await expect(provider.getPayout('nope')).resolves.toMatchObject({ status: 'unknown' });
  });

  it('finds a payout by idempotency key, and makes outcomes unclear on request', async () => {
    const provider = new SimulatedPromptPayProvider({ delayMs: 0, failureRate: 0, unknownRate: 1 });
    await expect(provider.findByIdempotencyKey('payment_1')).resolves.toBeNull();
    await provider.createPayout(request);
    await expect(provider.findByIdempotencyKey('payment_1')).resolves.toMatchObject({ status: 'unknown' });
  });

  it('gives a success a bank-like reference', async () => {
    const provider = new SimulatedPromptPayProvider({ delayMs: 0, failureRate: 0 });
    const { providerRef } = await provider.createPayout(request);
    await expect(provider.getPayout(providerRef!)).resolves.toMatchObject({
      status: 'succeeded',
      reference: expect.stringMatching(/^SIM[0-9A-F]{12}$/),
    });
  });
});
