import type { Payment } from '../domain/payment.js';
import type { PayoutTracker } from '../modules/payouts/payout-tracker.js';
import type { PaymentRepository, PaymentWithQuote, PayoutRepository } from '../ports/repositories.js';
import type { SettlementGateway } from '../ports/settlement-gateway.js';
import { PollingLoop, type WorkerLogger, silentLogger } from './loop.js';
import { RoundRobin } from './paging.js';

export interface PayoutWorkerDeps {
  payments: PaymentRepository;
  payouts: PayoutRepository;
  tracker: PayoutTracker;
  gateway: SettlementGateway;
  pollMs: number;
  /** False when there's no relayer key: settling and refunding need one. */
  enabled: boolean;
  batchSize?: number;
  now?: () => Date;
}

type Resolution = 'settle' | 'refund';

/**
 * Drives each paid payment to its end:
 *
 *   PAID → (payout row) → PAYOUT_PENDING → partner SUCCEEDED, with a reference → markSettled → SETTLED
 *                                         → partner FAILED, definitely         → refund      → REFUNDED
 *                                         → UNKNOWN or REVERSED: nothing automatic; re-checked, then an operator
 *
 * Every step is safe to repeat after a crash: the payout row and its idempotency key exist before the
 * partner is called, a retry looks the payout up before creating it again (PayoutTracker), and the
 * on-chain status is checked before settling or refunding.
 */
export class PayoutWorker {
  private readonly deps: PayoutWorkerDeps;
  private readonly loop: PollingLoop;
  private readonly batchSize: number;
  private readonly now: () => Date;
  /** Payout-pending payments are taken in turns, so ones that can't move yet don't hold up the rest. */
  private readonly due = new RoundRobin<PaymentWithQuote>(({ payment }) => ({ createdAt: payment.createdAt, id: payment.id }));
  private log: WorkerLogger = silentLogger;

  constructor(deps: PayoutWorkerDeps) {
    this.deps = deps;
    this.batchSize = deps.batchSize ?? 20;
    this.now = deps.now ?? (() => new Date());
    this.loop = new PollingLoop('payouts', deps.pollMs, () => this.tick());
  }

  start(log: WorkerLogger): void {
    this.log = log;
    if (!this.deps.enabled) {
      log.warn({ worker: 'payouts' }, 'SETTLEMENT_ADDRESS or RELAYER_PRIVATE_KEY is not set; payout worker not started');
      return;
    }
    this.loop.start(log);
  }

  async stop(): Promise<void> {
    await this.loop.stop();
  }

  /**
   * One pass over paid and payout-pending payments. One payment's error doesn't stop the others.
   * Only payouts with something to do are taken (not those waiting out a backoff after an unclear
   * answer), a page at a time, continuing where the last tick stopped: a partner outage that leaves
   * many payouts UNKNOWN never stops new payments from being sent to the partner.
   */
  async tick(): Promise<void> {
    const { payments } = this.deps;
    for (const item of await payments.listByStatus(['PAID'], this.batchSize)) {
      await this.guard(item, () => this.startPayout(item));
    }
    const now = this.now();
    for (const item of await this.due.next(this.batchSize, (after) => payments.listPayoutDue(now, this.batchSize, after))) {
      await this.guard(item, () => this.advance(item));
    }
  }

  private async guard({ payment }: PaymentWithQuote, step: () => Promise<void>): Promise<void> {
    try {
      await step();
    } catch (error) {
      this.log.error({ err: error, paymentId: payment.id }, 'payout step failed; will retry');
      // Shown to operators. The payout may not exist yet if the step failed before creating it.
      const message = error instanceof Error ? (error.message.split('\n')[0] ?? error.message) : String(error);
      await this.deps.payouts.update(payment.id, { lastError: message }).catch(() => undefined);
    }
  }

  private async startPayout(item: PaymentWithQuote): Promise<void> {
    await this.deps.tracker.ensurePayout(item);
    await this.deps.payments.transition(item.payment.id, 'PAID', 'PAYOUT_PENDING');
  }

  private async advance(item: PaymentWithQuote): Promise<void> {
    const payout = await this.deps.tracker.check(item);
    if (payout.status === 'SUCCEEDED') {
      await this.resolve(item.payment, 'settle');
    } else if (payout.status === 'FAILED') {
      await this.resolve(item.payment, 'refund', payout.failureReason ?? 'Payout failed');
    }
    // PENDING: wait. UNKNOWN or REVERSED: an operator decides (see /ops).
  }

  /** Records the final status, and clears the error shown to operators. */
  private async finish(paymentId: string, target: 'SETTLED' | 'REFUNDED', fields: { failureReason?: string }): Promise<void> {
    if (await this.deps.payments.transition(paymentId, 'PAYOUT_PENDING', target, fields)) {
      await this.deps.payouts.update(paymentId, { lastError: null });
    }
  }

  /** markSettled or refund on-chain, then record it once the transaction is in a block. */
  private async resolve(payment: Payment, action: Resolution, reason?: string): Promise<void> {
    const { gateway } = this.deps;
    const target = action === 'settle' ? 'SETTLED' : 'REFUNDED';
    const onChainTarget = action === 'settle' ? 'Settled' : 'Refunded';
    const field = action === 'settle' ? 'settleTxHash' : 'refundTxHash';
    const done = { ...(reason === undefined ? {} : { failureReason: reason }) };

    const sentBefore = payment[field];
    if (sentBefore) {
      const receipt = await gateway.getReceipt(sentBefore);
      if (!receipt) return; // still pending
      if (receipt.status === 'success') {
        await this.finish(payment.id, target, done);
        return;
      }
      // Reverted: check the contract below before trying again.
    }

    const onChain = await gateway.getPaymentStatus(payment.quoteId);
    if (onChain === onChainTarget) {
      // Done already, e.g. by a run that crashed before saving the transaction hash.
      await this.finish(payment.id, target, done);
      return;
    }
    if (onChain !== 'Paid') {
      this.log.error({ paymentId: payment.id, onChain, action }, 'cannot resolve payment: unexpected on-chain status');
      await this.deps.payouts.update(payment.id, { lastError: `Cannot ${action}: on-chain status is ${onChain}` });
      return;
    }

    const txHash = action === 'settle' ? await gateway.markSettled(payment.quoteId) : await gateway.refund(payment.quoteId);
    await this.deps.payments.update(payment.id, { [field]: txHash });
    const receipt = await gateway.waitForReceipt(txHash);
    if (receipt.status === 'success') {
      await this.finish(payment.id, target, done);
      this.log.info({ paymentId: payment.id, txHash, status: target }, 'payment resolved on-chain');
    } else {
      this.log.warn({ paymentId: payment.id, txHash, action }, 'transaction reverted; will check again');
      await this.deps.payouts.update(payment.id, { lastError: `${action === 'settle' ? 'markSettled' : 'refund'} transaction reverted` });
    }
  }
}
