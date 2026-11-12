import type { Payment } from '../domain/payment.js';
import type { PayoutProvider, PayoutResult } from '../ports/payout-provider.js';
import type { PaymentRepository, PaymentWithQuote, PayoutRepository } from '../ports/repositories.js';
import type { SettlementGateway } from '../ports/settlement-gateway.js';
import { PollingLoop, type WorkerLogger, silentLogger } from './loop.js';

export interface PayoutWorkerDeps {
  payments: PaymentRepository;
  payouts: PayoutRepository;
  provider: PayoutProvider;
  gateway: SettlementGateway;
  pollMs: number;
  /** False when there's no relayer key: settling and refunding need one. */
  enabled: boolean;
  batchSize?: number;
}

type Resolution = 'settle' | 'refund';

/**
 * Drives each paid payment to its end:
 *
 *   PAID → (create payout) → PAYOUT_PENDING → (partner pays the merchant) → markSettled → SETTLED
 *                                           → (partner fails)            → refund      → REFUNDED
 *
 * Every step is safe to repeat after a crash: the payout is created once per payment, the partner
 * call is idempotent per payment ID, and the on-chain status is checked before settling or refunding.
 */
export class PayoutWorker {
  private readonly deps: PayoutWorkerDeps;
  private readonly loop: PollingLoop;
  private readonly batchSize: number;
  private log: WorkerLogger = silentLogger;

  constructor(deps: PayoutWorkerDeps) {
    this.deps = deps;
    this.batchSize = deps.batchSize ?? 20;
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

  /** One pass over paid and payout-pending payments. One payment's error doesn't stop the others. */
  async tick(): Promise<void> {
    const { payments } = this.deps;
    for (const item of await payments.listByStatus(['PAID'], this.batchSize)) {
      await this.guard(item, () => this.startPayout(item));
    }
    for (const item of await payments.listByStatus(['PAYOUT_PENDING'], this.batchSize)) {
      await this.guard(item, () => this.advance(item));
    }
  }

  private async guard({ payment }: PaymentWithQuote, step: () => Promise<void>): Promise<void> {
    try {
      await step();
    } catch (error) {
      this.log.error({ err: error, paymentId: payment.id }, 'payout step failed; will retry');
    }
  }

  private async startPayout({ payment, quote }: PaymentWithQuote): Promise<void> {
    await this.deps.payouts.createForPayment({
      paymentId: payment.id,
      provider: this.deps.provider.name,
      amount: quote.quote.fiat,
    });
    await this.deps.payments.transition(payment.id, 'PAID', 'PAYOUT_PENDING');
  }

  private async advance({ payment, quote }: PaymentWithQuote): Promise<void> {
    const { payouts, provider } = this.deps;
    let payout =
      (await payouts.findByPaymentId(payment.id)) ??
      (await payouts.createForPayment({ paymentId: payment.id, provider: provider.name, amount: quote.quote.fiat }));

    if (payout.status === 'PENDING') {
      let result: PayoutResult;
      if (payout.providerRef) {
        result = await provider.getPayout(payout.providerRef);
      } else {
        await payouts.update(payment.id, { attempts: payout.attempts + 1 });
        result = await provider.createPayout({ paymentId: payment.id, merchant: quote.quote.merchant, amount: payout.amount });
      }
      const providerRef = result.providerRef ?? payout.providerRef;
      if (result.status === 'pending') {
        if (providerRef !== payout.providerRef) await payouts.update(payment.id, { providerRef: result.providerRef });
        return;
      }
      payout = await payouts.update(payment.id, {
        ...(providerRef === undefined ? {} : { providerRef }),
        status: result.status === 'succeeded' ? 'SUCCEEDED' : 'FAILED',
        ...(result.status === 'failed' ? { failureReason: result.reason } : {}),
      });
      this.log.info({ paymentId: payment.id, payout: payout.status }, 'payout finished');
    }

    if (payout.status === 'SUCCEEDED') await this.resolve(payment, 'settle');
    else await this.resolve(payment, 'refund', payout.failureReason ?? 'Payout failed');
  }

  /** markSettled or refund on-chain, then record it once the transaction is in a block. */
  private async resolve(payment: Payment, action: Resolution, reason?: string): Promise<void> {
    const { gateway, payments } = this.deps;
    const target = action === 'settle' ? 'SETTLED' : 'REFUNDED';
    const onChainTarget = action === 'settle' ? 'Settled' : 'Refunded';
    const field = action === 'settle' ? 'settleTxHash' : 'refundTxHash';
    const done = { ...(reason === undefined ? {} : { failureReason: reason }) };

    const sentBefore = payment[field];
    if (sentBefore) {
      const receipt = await gateway.getReceipt(sentBefore);
      if (!receipt) return; // still pending
      if (receipt.status === 'success') {
        await payments.transition(payment.id, 'PAYOUT_PENDING', target, done);
        return;
      }
      // Reverted: check the contract below before trying again.
    }

    const onChain = await gateway.getPaymentStatus(payment.quoteId);
    if (onChain === onChainTarget) {
      // Done already, e.g. by a run that crashed before saving the transaction hash.
      await payments.transition(payment.id, 'PAYOUT_PENDING', target, done);
      return;
    }
    if (onChain !== 'Paid') {
      this.log.error({ paymentId: payment.id, onChain, action }, 'cannot resolve payment: unexpected on-chain status');
      return;
    }

    const txHash = action === 'settle' ? await gateway.markSettled(payment.quoteId) : await gateway.refund(payment.quoteId);
    await payments.update(payment.id, { [field]: txHash });
    const receipt = await gateway.waitForReceipt(txHash);
    if (receipt.status === 'success') {
      await payments.transition(payment.id, 'PAYOUT_PENDING', target, done);
      this.log.info({ paymentId: payment.id, txHash, status: target }, 'payment resolved on-chain');
    } else {
      this.log.warn({ paymentId: payment.id, txHash, action }, 'transaction reverted; will check again');
    }
  }
}
