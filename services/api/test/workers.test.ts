import { type Hex, keccak256, toHex } from 'viem';
import { afterEach, describe, expect, it } from 'vitest';
import { SimulatedPromptPayProvider } from '../src/adapters/payouts/simulated-promptpay-provider.js';
import { buildPromptPayQr } from '../src/lib/promptpay/build.js';
import { IndexerWorker } from '../src/workers/indexer.js';
import type { WorkerLogger } from '../src/workers/loop.js';
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
        const { providerRef } = await provider.createPayout({ ...request, paymentId: `p${i}` });
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

  it('fails an unknown reference', async () => {
    const provider = new SimulatedPromptPayProvider({ delayMs: 0, failureRate: 0 });
    await expect(provider.getPayout('nope')).resolves.toMatchObject({ status: 'failed' });
  });
});
