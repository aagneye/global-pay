import type { Address, Hex } from 'viem';
import type { FiatAmount } from '../../domain/money.js';
import type { P2pStatus } from '../../domain/p2p.js';
import type { Payment, Payout, PayoutEvent, PayoutStatus } from '../../domain/payment.js';
import type { PayoutProvider } from '../../ports/payout-provider.js';
import type {
  OpsAction,
  OpsActionRepository,
  PaymentRepository,
  PaymentRequestRepository,
  PaymentWithQuote,
  PayoutRepository,
} from '../../ports/repositories.js';
import type { SettlementGateway } from '../../ports/settlement-gateway.js';
import { AppError } from '../../shared/errors.js';
import type { PayoutTracker } from '../payouts/payout-tracker.js';

export interface OpsServiceDeps {
  payments: PaymentRepository;
  payouts: PayoutRepository;
  /** Tap-to-pay requests, for transfers stuck without a receipt. */
  requests: PaymentRequestRepository;
  actions: OpsActionRepository;
  tracker: PayoutTracker;
  payoutRail: Pick<PayoutProvider, 'name' | 'getBalance'>;
  gateway: Pick<SettlementGateway, 'getRelayerBalance' | 'getReceipt' | 'getPaymentStatus'>;
  /** An UNKNOWN payout older than this is flagged as needing an operator. */
  escalateAfterMs: number;
  /** An operator may approve a refund only once the payout has been UNKNOWN this long. */
  refundCooloffMs: number;
  minRelayerWei: bigint;
  minFloatMinor: bigint;
  /** A payment PAID for longer than this without a payout is flagged. */
  stuckPaidMs?: number;
  /** A transaction (or a payment still SUBMITTED) older than this without a result is flagged. */
  stuckTxMs?: number;
  now?: () => Date;
}

export type ExceptionKind =
  | 'paid_without_payout'
  | 'payout_unknown'
  | 'payout_reversed'
  | 'partner_error'
  | 'resolution_stuck'
  | 'payout_conflict'
  /** The on-chain payment differs from its quote (amount, payer, token or merchant): never paid out. */
  | 'event_mismatch'
  /** Still SUBMITTED long after its quote expired: no receipt, or paid on-chain without its event seen. */
  | 'payment_unconfirmed'
  /** A markSettled or refund transaction with no receipt after OPS_STUCK_TX_AFTER_MS. */
  | 'transaction_stuck'
  /** A tap-to-pay transfer with no receipt after OPS_STUCK_TX_AFTER_MS. `paymentId` is the request's ID. */
  | 'p2p_transaction_stuck';

export interface OpsException {
  kind: ExceptionKind;
  /** Needs a person now, not just attention. */
  escalated: boolean;
  /** The payment, or for p2p_ kinds the tap-to-pay request. */
  paymentId: string;
  paymentStatus: Payment['status'] | P2pStatus;
  payoutStatus?: PayoutStatus;
  /** Baht for payments; USDC base units for p2p_ kinds. */
  amount: FiatAmount | { currency: 'USDC'; minor: bigint };
  /** The merchant, or for p2p_ kinds the receiver's address. */
  merchant: string;
  /** When it started: the payment's last change, or when the payout became UNKNOWN. */
  since: Date;
  lastError?: string;
  providerRef?: string;
  providerReference?: string;
  /** The transaction with no receipt, for the stuck-transaction kinds. */
  txHash?: Hex;
}

export interface OpsHealth {
  partner: { name: string; float: FiatAmount | null; ok: boolean; error?: string };
  relayer: { address: Address; wei: bigint; ok: boolean } | null;
  payouts: Record<PayoutStatus, number>;
  alerts: string[];
  checkedAt: Date;
}

export interface OpsActor {
  actor: string;
  note: string;
}

const LIMIT = 200;

/**
 * What operators see and may do (ADR 0008). Every action re-checks the partner first, is allowed only
 * from the state it's meant for, and is written to the audit log.
 */
export class OpsService {
  private readonly deps: OpsServiceDeps;
  private readonly now: () => Date;

  constructor(deps: OpsServiceDeps) {
    this.deps = deps;
    this.now = deps.now ?? (() => new Date());
  }

  /** Everything that needs attention, most urgent first. */
  async exceptions(): Promise<OpsException[]> {
    const { payments, payouts, escalateAfterMs } = this.deps;
    const now = this.now().getTime();
    const stuckPaidMs = this.deps.stuckPaidMs ?? 5 * 60_000;
    const stuckTxMs = this.deps.stuckTxMs ?? 10 * 60_000;
    const items: OpsException[] = [];

    // A payment resolves within the quote's lifetime plus a minute, unless the chain and our records disagree.
    for (const item of await payments.listByStatus(['SUBMITTED'], LIMIT)) {
      if (now - item.payment.createdAt.getTime() < stuckTxMs) continue;
      items.push({
        ...describe(item),
        kind: 'payment_unconfirmed',
        escalated: true,
        since: item.payment.createdAt,
        lastError: await this.whyUnconfirmed(item.payment),
      });
    }

    for (const item of await payments.listByStatus(['PAID'], LIMIT)) {
      if (now - item.payment.updatedAt.getTime() < stuckPaidMs) continue;
      items.push({ ...describe(item), kind: 'paid_without_payout', escalated: true, since: item.payment.updatedAt });
    }

    for (const item of await payments.listEventMismatches(LIMIT)) {
      items.push({
        ...describe(item),
        kind: 'event_mismatch',
        escalated: true,
        since: item.payment.updatedAt,
        lastError: item.payment.eventMismatch!,
      });
    }

    // Settle or refund transactions without a receipt, and decided payouts nobody resolved, are listed
    // once, with that reason, rather than as the payout's last error.
    const stuck = await this.stuckResolutions(now, stuckTxMs);
    items.push(...stuck);
    const listed = new Set(stuck.map((item) => item.paymentId));

    for (const payout of await payouts.listNeedingAttention(LIMIT)) {
      if (listed.has(payout.paymentId)) continue;
      const item = await payments.findById(payout.paymentId);
      if (!item) continue;
      const kind = classify(payout, item.payment);
      const since = payout.unknownSince ?? payout.updatedAt;
      const escalated =
        kind === 'payout_reversed' ||
        kind === 'payout_conflict' ||
        (kind === 'payout_unknown' && now - since.getTime() >= escalateAfterMs);
      items.push({ ...describe(item, payout), kind, escalated, since });
    }

    items.push(...(await this.stuckTransfers(now, stuckTxMs)));
    return items.sort((a, b) => Number(b.escalated) - Number(a.escalated) || a.since.getTime() - b.since.getTime());
  }

  async health(): Promise<OpsHealth> {
    const { payoutRail, gateway, payouts, minFloatMinor, minRelayerWei } = this.deps;
    const alerts: string[] = [];

    let partner: OpsHealth['partner'];
    try {
      const float = await payoutRail.getBalance();
      const ok = float === null || float.minor >= minFloatMinor;
      if (!ok) alerts.push(`Payout float is low: ${formatMinor(float!.minor)} ${float!.currency}`);
      partner = { name: payoutRail.name, float, ok };
    } catch (error) {
      alerts.push(`Payout partner unreachable: ${(error as Error).message}`);
      partner = { name: payoutRail.name, float: null, ok: false, error: (error as Error).message };
    }

    let relayer: OpsHealth['relayer'] = null;
    try {
      const balance = await gateway.getRelayerBalance();
      if (balance) {
        relayer = { ...balance, ok: balance.wei >= minRelayerWei };
        if (!relayer.ok) alerts.push(`Relayer is low on gas: ${balance.address}`);
      } else {
        alerts.push('No relayer key: payments cannot be settled or refunded');
      }
    } catch (error) {
      alerts.push(`Chain unreachable: ${(error as Error).message}`);
    }

    const counts = await payouts.countByStatus();
    if (counts.UNKNOWN > 0) alerts.push(`${counts.UNKNOWN} payout(s) with an unclear outcome`);
    if (counts.REVERSED > 0) alerts.push(`${counts.REVERSED} reversed payout(s)`);

    return { partner, relayer, payouts: counts, alerts, checkedAt: this.now() };
  }

  /** A payout with its partner events and operator actions. */
  async payout(paymentId: string): Promise<{ payout: Payout; events: PayoutEvent[]; actions: OpsAction[] }> {
    const payout = await this.requirePayout(paymentId);
    const [events, actions] = await Promise.all([
      this.deps.payouts.listEvents(paymentId, 50),
      this.deps.actions.list(50, { type: 'payout', id: paymentId }),
    ]);
    return { payout, events, actions };
  }

  /** Asks the partner again now, ignoring the backoff. May create the payout if the partner has none. */
  async recheck(paymentId: string, { actor, note }: OpsActor): Promise<Payout> {
    const item = await this.requireItem(paymentId);
    const before = await this.requirePayout(paymentId);
    const after = await this.deps.tracker.check(item, { force: true });
    await this.audit('recheck', paymentId, actor, note, { from: before.status, to: after.status });
    return after;
  }

  /**
   * The merchant was paid, as confirmed outside the system (e.g. the partner's support gave the bank
   * reference). Only from UNKNOWN, and only if the partner doesn't now say otherwise. The payout worker
   * then settles the payment.
   */
  async markPaid(paymentId: string, input: OpsActor & { reference: string }): Promise<Payout> {
    const payout = await this.refreshUnknown(paymentId);
    const moved = await this.deps.payouts.transition(paymentId, 'UNKNOWN', 'SUCCEEDED', {
      providerReference: input.reference,
      unknownSince: null,
      nextCheckAt: null,
      lastError: null,
    });
    if (!moved) throw changed('it changed while you were looking');
    await this.deps.payouts.recordEvent(paymentId, {
      source: 'ops',
      providerStatus: 'MARKED_PAID',
      payload: { actor: input.actor, reference: input.reference, note: input.note },
    });
    await this.audit('mark_paid', paymentId, input.actor, input.note, { reference: input.reference, from: payout.status });
    return this.requirePayout(paymentId);
  }

  /**
   * Gives up on the payout so the user is refunded. Only from UNKNOWN, after the cooling-off period, and
   * only when the partner has no such payout. (If the partner says it failed, the refund is automatic.)
   */
  async approveRefund(paymentId: string, { actor, note }: OpsActor): Promise<Payout> {
    const payout = await this.refreshUnknown(paymentId);
    const unknownFor = this.now().getTime() - (payout.unknownSince ?? payout.updatedAt).getTime();
    if (unknownFor < this.deps.refundCooloffMs) {
      const minutes = Math.ceil((this.deps.refundCooloffMs - unknownFor) / 60_000);
      throw new AppError('refund_too_early', `Wait ${minutes} more minute(s): the partner may still pay it`, 409);
    }
    if (payout.providerRef) {
      throw new AppError(
        'partner_has_payout',
        'The partner has this payout and has not said it failed; ask the partner before refunding',
        409,
      );
    }
    const moved = await this.deps.payouts.transition(paymentId, 'UNKNOWN', 'FAILED', {
      failureReason: 'Refund approved by an operator: the partner has no record of the payout',
      unknownSince: null,
      nextCheckAt: null,
      lastError: null,
    });
    if (!moved) throw changed('it changed while you were looking');
    await this.deps.payouts.recordEvent(paymentId, {
      source: 'ops',
      providerStatus: 'REFUND_APPROVED',
      payload: { actor, note },
    });
    await this.audit('approve_refund', paymentId, actor, note, { unknownForMs: unknownFor });
    return this.requirePayout(paymentId);
  }

  /** Operator actions, newest first. */
  async actions(limit: number): Promise<OpsAction[]> {
    return this.deps.actions.list(limit);
  }

  /**
   * Re-checks an UNKNOWN payout with the partner (without creating it) and applies the answer.
   * Throws unless it's still UNKNOWN afterwards: then the partner has decided, not the operator.
   */
  private async refreshUnknown(paymentId: string): Promise<Payout> {
    let payout = await this.requirePayout(paymentId);
    if (payout.status !== 'UNKNOWN') throw changed(`it is ${payout.status}, and only UNKNOWN payouts can be resolved by hand`);
    let answer;
    try {
      answer = await this.deps.tracker.lookup(payout);
    } catch (error) {
      throw new AppError('payout_partner_error', `Couldn't re-check with the partner: ${(error as Error).message}`, 503);
    }
    if (answer) payout = await this.deps.tracker.apply(payout, answer, 'ops');
    if (payout.status !== 'UNKNOWN') throw changed(`the partner now reports it as ${payout.status}; nothing else was changed`);
    return payout;
  }

  /**
   * Payouts decided at least `stuckTxMs` ago whose payment is still PAYOUT_PENDING: the markSettled or
   * refund transaction has no receipt, or none was sent and nothing has failed (the worker isn't running).
   * Mined transactions are left to the worker, which records them or retries a revert (with its error).
   */
  private async stuckResolutions(now: number, stuckTxMs: number): Promise<OpsException[]> {
    const { payments, gateway } = this.deps;
    const items: OpsException[] = [];
    for (const item of await payments.listAwaitingResolution(new Date(now - stuckTxMs), LIMIT)) {
      const payout = item.payout!;
      const action = payout.status === 'SUCCEEDED' ? 'markSettled' : 'refund';
      const hash = payout.status === 'SUCCEEDED' ? item.payment.settleTxHash : item.payment.refundTxHash;
      if (hash) {
        const receipt = await gateway.getReceipt(hash).catch(() => undefined);
        if (receipt) continue;
        const age = minutes(now - item.payment.updatedAt.getTime());
        items.push({
          ...describe(item, payout),
          kind: 'transaction_stuck',
          escalated: true,
          since: item.payment.updatedAt,
          txHash: hash,
          lastError:
            receipt === null
              ? `${action} transaction ${hash} has no receipt after ${age} minutes`
              : `${action} transaction ${hash} is ${age} minutes old; couldn't check the chain for its receipt`,
        });
      } else if (!payout.lastError && now - payout.updatedAt.getTime() >= stuckTxMs) {
        items.push({
          ...describe(item, payout),
          kind: 'resolution_stuck',
          escalated: true,
          since: payout.updatedAt,
          lastError: `Payout ${payout.status}, but no ${action} was sent after ${minutes(now - payout.updatedAt.getTime())} minutes; is the payout worker running?`,
        });
      }
    }
    return items;
  }

  /** Tap-to-pay transfers sent at least `stuckTxMs` ago without a receipt. */
  private async stuckTransfers(now: number, stuckTxMs: number): Promise<OpsException[]> {
    const { requests, gateway } = this.deps;
    const items: OpsException[] = [];
    for (const request of await requests.listByStatus(['APPROVING', 'SUBMITTED'], LIMIT)) {
      if (!request.txHash || now - request.updatedAt.getTime() < stuckTxMs) continue;
      const receipt = await gateway.getReceipt(request.txHash).catch(() => undefined);
      if (receipt) continue;
      const age = minutes(now - request.updatedAt.getTime());
      items.push({
        kind: 'p2p_transaction_stuck',
        escalated: true,
        paymentId: request.id,
        paymentStatus: request.status,
        amount: { currency: 'USDC', minor: request.amount },
        merchant: request.receiverAddress,
        since: request.updatedAt,
        txHash: request.txHash,
        lastError:
          receipt === null
            ? `Transfer ${request.txHash} has no receipt after ${age} minutes`
            : `Transfer ${request.txHash} is ${age} minutes old; couldn't check the chain for its receipt`,
      });
    }
    return items;
  }

  /** What the chain says about a payment that is still SUBMITTED. */
  private async whyUnconfirmed(payment: Payment): Promise<string> {
    const { gateway } = this.deps;
    try {
      const onChain = await gateway.getPaymentStatus(payment.quoteId);
      const hash = payment.payTxHash;
      if (!hash) return `No pay() transaction recorded; the chain shows the quote as ${onChain}`;
      const receipt = await gateway.getReceipt(hash);
      if (!receipt) return `pay() transaction ${hash} has no receipt; the chain shows the quote as ${onChain}`;
      if (receipt.status === 'reverted') {
        return `pay() transaction ${hash} reverted, but the chain shows the quote as ${onChain}; its PaymentReceived event hasn't been processed`;
      }
      return `pay() transaction ${hash} was mined in block ${receipt.blockNumber}, but its PaymentReceived event hasn't been processed`;
    } catch (error) {
      return `Couldn't check the chain: ${(error as Error).message}`;
    }
  }

  private async requireItem(paymentId: string): Promise<PaymentWithQuote> {
    const item = await this.deps.payments.findById(paymentId);
    if (!item) throw new AppError('not_found', 'No such payment', 404);
    return item;
  }

  private async requirePayout(paymentId: string): Promise<Payout> {
    const payout = await this.deps.payouts.findByPaymentId(paymentId);
    if (!payout) throw new AppError('not_found', 'This payment has no payout yet', 404);
    return payout;
  }

  private async audit(action: string, paymentId: string, actor: string, note: string, details: unknown): Promise<void> {
    await this.deps.actions.record({ action, targetType: 'payout', targetId: paymentId, actor, note, details });
  }
}

function changed(why: string): AppError {
  return new AppError('payout_changed', `Not done: ${why}`, 409);
}

function classify(payout: Payout, payment: Payment): ExceptionKind {
  if (payout.status === 'UNKNOWN') return 'payout_unknown';
  if (payout.status === 'REVERSED') return 'payout_reversed';
  if (payment.status !== 'PAYOUT_PENDING') return 'payout_conflict';
  return payout.status === 'PENDING' ? 'partner_error' : 'resolution_stuck';
}

function describe({ payment, quote }: PaymentWithQuote, payout?: Payout) {
  return {
    paymentId: payment.id,
    paymentStatus: payment.status,
    amount: quote.quote.fiat,
    merchant: quote.quote.merchantRef,
    ...(payout
      ? {
          payoutStatus: payout.status,
          ...(payout.lastError ? { lastError: payout.lastError } : {}),
          ...(payout.providerRef ? { providerRef: payout.providerRef } : {}),
          ...(payout.providerReference ? { providerReference: payout.providerReference } : {}),
        }
      : {}),
  };
}

const minutes = (ms: number) => Math.floor(ms / 60_000);

function formatMinor(minor: bigint): string {
  const sign = minor < 0n ? '-' : '';
  const abs = minor < 0n ? -minor : minor;
  return `${sign}${abs / 100n}.${(abs % 100n).toString().padStart(2, '0')}`;
}
