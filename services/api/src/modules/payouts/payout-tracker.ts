import type { Payout } from '../../domain/payment.js';
import type { PayoutProvider, PayoutResult, PayoutWebhookRef } from '../../ports/payout-provider.js';
import type { PaymentWithQuote, PayoutFields, PayoutRepository } from '../../ports/repositories.js';
import { PayoutRouter } from './payout-router.js';

export interface PayoutTrackerDeps {
  payouts: PayoutRepository;
  /** The PromptPay partner (PAYOUT_PROVIDER): webhooks and operator float come from it. */
  provider: PayoutProvider;
  /** Routes UPI merchants to their partner; without it, everything goes to `provider`. */
  router?: PayoutRouter;
  /** How often to ask the partner about a pending payout. */
  recheckMs: number;
  /** A payout still pending after this long becomes UNKNOWN. */
  pendingDeadlineMs: number;
  now?: () => Date;
}

type Source = 'create' | 'check' | 'webhook' | 'ops';

const MIN_UNKNOWN_BACKOFF_MS = 30_000;
const MAX_UNKNOWN_BACKOFF_MS = 60 * 60_000;

/**
 * Keeps each payout's status in line with what the partner says. Used by the payout worker, the partner
 * webhook and the operator re-check, so all three apply answers the same way.
 *
 * Rules (ADR 0008):
 * - The payout row, with its idempotency key, exists before the partner is called. Before calling create
 *   again, look the payout up by that key: a retry can never pay twice.
 * - SUCCEEDED needs a reference. A success without one becomes UNKNOWN.
 * - Only a definite failure becomes FAILED. Anything unclear becomes UNKNOWN: re-checked with backoff,
 *   never settled or refunded automatically.
 * - A partner that can't be reached changes nothing; the error is recorded for operators.
 */
export class PayoutTracker {
  private readonly deps: PayoutTrackerDeps;
  private readonly now: () => Date;
  private readonly router: PayoutRouter;

  constructor(deps: PayoutTrackerDeps) {
    this.deps = deps;
    this.now = deps.now ?? (() => new Date());
    this.router = deps.router ?? new PayoutRouter({ promptpay: deps.provider });
  }

  get providerName(): string {
    return this.deps.provider.name;
  }

  /**
   * Checks a partner webhook's authenticity. `undefined` if the active partner doesn't send webhooks,
   * null if this one isn't authentic.
   */
  parseWebhook(headers: Record<string, string | string[] | undefined>, body: unknown): PayoutWebhookRef | null | undefined {
    const { provider } = this.deps;
    return provider.parseWebhook ? provider.parseWebhook(headers, body) : undefined;
  }

  /** The payment's payout, created (PENDING, not yet sent) if it doesn't exist. */
  async ensurePayout({ payment, quote }: PaymentWithQuote): Promise<Payout> {
    return (
      (await this.deps.payouts.findByPaymentId(payment.id)) ??
      this.deps.payouts.createForPayment({
        paymentId: payment.id,
        provider: (this.router.forMerchant(quote.quote.merchant) ?? this.deps.provider).name,
        amount: quote.quote.fiat,
        idempotencyKey: payment.id,
      })
    );
  }

  /**
   * Sends the payout, or asks the partner about it, and records the answer.
   * Only PENDING and UNKNOWN payouts are checked; `force` ignores the backoff (operator re-check).
   */
  async check(item: PaymentWithQuote, options: { force?: boolean } = {}): Promise<Payout> {
    const { payouts } = this.deps;
    const payout = await this.ensurePayout(item);
    if (payout.status !== 'PENDING' && payout.status !== 'UNKNOWN') return payout;
    const now = this.now();
    if (!options.force && payout.nextCheckAt && now < payout.nextCheckAt) return payout;

    const provider = this.router.named(payout.provider);
    if (!provider) {
      return this.noteError(payout, `Created with ${payout.provider}, but the active partner is ${this.deps.provider.name}`);
    }

    let result: PayoutResult;
    let source: Source = 'check';
    try {
      if (payout.providerRef) {
        result = await provider.getPayout(payout.providerRef);
      } else {
        const found = await provider.findByIdempotencyKey(payout.idempotencyKey);
        if (found) {
          result = found;
        } else {
          await payouts.update(payout.paymentId, { attempts: payout.attempts + 1 });
          source = 'create';
          result = await provider.createPayout({
            idempotencyKey: payout.idempotencyKey,
            paymentId: payout.paymentId,
            merchant: item.quote.quote.merchant,
            amount: payout.amount,
          });
        }
      }
    } catch (error) {
      return this.noteError(payout, `Partner unreachable: ${(error as Error).message}`);
    }
    return this.apply(payout, result, source);
  }

  /**
   * Asks the partner about a payout without ever creating it: by its partner ID if it has one, else by
   * idempotency key. null means the partner has no such payout. Used by operator actions.
   */
  async lookup(payout: Payout): Promise<PayoutResult | null> {
    const provider = this.router.named(payout.provider) ?? this.deps.provider;
    return payout.providerRef ? provider.getPayout(payout.providerRef) : provider.findByIdempotencyKey(payout.idempotencyKey);
  }

  /** A webhook arrived: find the payout, re-fetch it from the partner (webhooks aren't trusted alone), apply. */
  async onWebhook(ref: PayoutWebhookRef, payload: unknown): Promise<'applied' | 'ignored'> {
    const { payouts, provider } = this.deps;
    const payout = ref.idempotencyKey ? await payouts.findByIdempotencyKey(ref.idempotencyKey) : null;
    if (!payout || payout.provider !== provider.name) return 'ignored';
    await payouts.recordEvent(payout.paymentId, { source: 'webhook', payload });

    const providerRef = payout.providerRef ?? ref.providerRef;
    if (!providerRef) return 'ignored';
    let result: PayoutResult;
    try {
      result = await provider.getPayout(providerRef);
    } catch (error) {
      await this.noteError(payout, `Partner unreachable after webhook: ${(error as Error).message}`);
      return 'ignored';
    }
    await this.apply(payout, result, 'webhook');
    return 'applied';
  }

  /** Applies a partner answer to the payout and returns the payout as stored afterwards. */
  async apply(payout: Payout, result: PayoutResult, source: Source): Promise<Payout> {
    const { payouts } = this.deps;
    const now = this.now();
    await payouts.recordEvent(payout.paymentId, {
      source,
      ...(result.providerStatus === undefined ? {} : { providerStatus: result.providerStatus }),
      payload: result.raw ?? { ...result, raw: undefined },
    });
    const seen: PayoutFields = {
      ...(result.providerRef === undefined ? {} : { providerRef: result.providerRef }),
      ...(result.providerStatus === undefined ? {} : { providerStatus: result.providerStatus }),
      lastCheckedAt: now,
    };
    const open = payout.status === 'PENDING' || payout.status === 'UNKNOWN';

    switch (result.status) {
      case 'succeeded':
        if (!result.reference) return this.toUnknown(payout, 'Partner reported success without a reference', seen);
        if (open) {
          await payouts.transition(payout.paymentId, payout.status, 'SUCCEEDED', {
            ...seen,
            providerReference: result.reference,
            unknownSince: null,
            nextCheckAt: null,
            lastError: null,
          });
        } else if (payout.status === 'FAILED') {
          // Paid after we gave up on it: the user may have been refunded too. An operator must look.
          await payouts.update(payout.paymentId, {
            ...seen,
            providerReference: result.reference,
            lastError: 'Partner reports this payout as paid, but it was treated as failed',
          });
        } else {
          await payouts.update(payout.paymentId, seen);
        }
        break;
      case 'failed':
        if (open) {
          await payouts.transition(payout.paymentId, payout.status, 'FAILED', {
            ...seen,
            failureReason: result.reason,
            unknownSince: null,
            nextCheckAt: null,
            lastError: null,
          });
        } else {
          await payouts.update(payout.paymentId, { ...seen, lastError: `Partner now says failed: ${result.reason}` });
        }
        break;
      case 'reversed':
        if (payout.status === 'SUCCEEDED') {
          await payouts.transition(payout.paymentId, 'SUCCEEDED', 'REVERSED', {
            ...seen,
            failureReason: result.reason ?? 'Payout reversed by the partner',
          });
        } else {
          return this.toUnknown(payout, 'Partner reports the payout as reversed', seen);
        }
        break;
      case 'pending': {
        const overdue = now.getTime() - payout.createdAt.getTime() > this.deps.pendingDeadlineMs;
        if (overdue) {
          return this.toUnknown(payout, `Still pending after ${Math.round(this.deps.pendingDeadlineMs / 60_000)} minutes`, seen);
        }
        const next = { ...seen, nextCheckAt: new Date(now.getTime() + this.deps.recheckMs) };
        if (payout.status === 'UNKNOWN') {
          await payouts.transition(payout.paymentId, 'UNKNOWN', 'PENDING', { ...next, unknownSince: null, lastError: null });
        } else {
          await payouts.update(payout.paymentId, next);
        }
        break;
      }
      case 'unknown':
        return this.toUnknown(payout, result.reason, seen);
    }
    return (await payouts.findByPaymentId(payout.paymentId)) ?? payout;
  }

  private async toUnknown(payout: Payout, reason: string, seen: PayoutFields): Promise<Payout> {
    const { payouts } = this.deps;
    const now = this.now();
    if (payout.status === 'PENDING') {
      await payouts.transition(payout.paymentId, 'PENDING', 'UNKNOWN', {
        ...seen,
        unknownSince: now,
        lastError: reason,
        nextCheckAt: new Date(now.getTime() + MIN_UNKNOWN_BACKOFF_MS),
      });
    } else if (payout.status === 'UNKNOWN') {
      // Back off as it ages: half its age, between 30 seconds and an hour.
      const age = now.getTime() - (payout.unknownSince ?? now).getTime();
      const wait = Math.min(Math.max(age / 2, MIN_UNKNOWN_BACKOFF_MS), MAX_UNKNOWN_BACKOFF_MS);
      await payouts.update(payout.paymentId, { ...seen, lastError: reason, nextCheckAt: new Date(now.getTime() + wait) });
    } else {
      await payouts.update(payout.paymentId, { ...seen, lastError: reason });
    }
    return (await payouts.findByPaymentId(payout.paymentId)) ?? payout;
  }

  /** Records an error without changing the status: nothing was learned. */
  private async noteError(payout: Payout, message: string): Promise<Payout> {
    const now = this.now();
    return this.deps.payouts.update(payout.paymentId, {
      lastError: message,
      lastCheckedAt: now,
      nextCheckAt: new Date(now.getTime() + Math.max(this.deps.recheckMs, MIN_UNKNOWN_BACKOFF_MS)),
    });
  }
}
