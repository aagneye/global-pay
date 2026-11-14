import { createHash } from 'node:crypto';
import type { Merchant } from '../../domain/merchant.js';
import type { FiatAmount } from '../../domain/money.js';
import type { PayoutProvider, PayoutRequest, PayoutResult } from '../../ports/payout-provider.js';

export interface SimulatedPromptPayOptions {
  /** How long a payout stays `pending` before it resolves. */
  delayMs: number;
  /** Share of payouts that fail (0..1). 1 fails them all, to exercise refunds. */
  failureRate: number;
  /** Share of payouts whose outcome stays unclear (0..1). 1 makes them all UNKNOWN, for the operator flow. */
  unknownRate?: number;
  /** The simulated payout float, or undefined for unlimited. */
  float?: FiatAmount;
  now?: () => number;
}

const PREFIX = 'sim';

/**
 * Stand-in for a licensed Thai partner paying a PromptPay QR in THB.
 * No money moves. It only simulates timing, failures, unclear outcomes and references.
 *
 * It keeps almost no state: the partner ID encodes the idempotency key and the start time, and the
 * outcome depends only on the key. So results survive a restart, and the same payment always gets the
 * same outcome. Only the lookup by idempotency key is remembered in memory.
 */
export class SimulatedPromptPayProvider implements PayoutProvider {
  readonly name = 'simulated-promptpay';
  private readonly options: SimulatedPromptPayOptions;
  private readonly now: () => number;
  private readonly started = new Map<string, string>();

  constructor(options: SimulatedPromptPayOptions) {
    this.options = options;
    this.now = options.now ?? Date.now;
  }

  /** Any PromptPay QR; UPI merchants go to SimulatedUpiProvider. */
  supports(merchant: Merchant): boolean {
    return merchant.kind !== 'upi';
  }

  async createPayout(request: PayoutRequest): Promise<PayoutResult> {
    let providerRef = this.started.get(request.idempotencyKey);
    if (!providerRef) {
      providerRef = `${PREFIX}_${request.idempotencyKey}_${this.now()}`;
      this.started.set(request.idempotencyKey, providerRef);
    }
    if (request.amount.minor <= 0n) {
      return { status: 'failed', providerRef, reason: 'Amount must be positive', providerStatus: 'REJECTED' };
    }
    return { status: 'pending', providerRef, providerStatus: 'ACCEPTED' };
  }

  async getPayout(providerRef: string): Promise<PayoutResult> {
    const match = /^sim_(.+)_(\d+)$/.exec(providerRef);
    if (!match?.[1] || !match[2]) {
      return { status: 'unknown', providerRef, reason: 'Unknown payout reference' };
    }
    const [, key, startedAt] = match;

    if (this.now() - Number(startedAt) < this.options.delayMs) {
      return { status: 'pending', providerRef, providerStatus: 'ACCEPTED' };
    }
    if (draw(key, 'unknown') < (this.options.unknownRate ?? 0)) {
      return { status: 'unknown', providerRef, reason: 'Simulated unclear outcome (PAYOUT_UNKNOWN_RATE)' };
    }
    if (draw(key, 'failure') < this.options.failureRate) {
      return {
        status: 'failed',
        providerRef,
        reason: 'Simulated payout failure (PAYOUT_FAILURE_RATE)',
        providerStatus: 'FAILED',
      };
    }
    return { status: 'succeeded', providerRef, reference: simulatedReference(providerRef), providerStatus: 'SUCCEEDED' };
  }

  async findByIdempotencyKey(idempotencyKey: string): Promise<PayoutResult | null> {
    const providerRef = this.started.get(idempotencyKey);
    return providerRef ? this.getPayout(providerRef) : null;
  }

  async getBalance(): Promise<FiatAmount | null> {
    return this.options.float ?? null;
  }
}

/** A number in [0, 1) fixed by the key, independent for each kind of outcome. */
function draw(key: string, kind: string): number {
  const salt = kind === 'failure' ? '' : `:${kind}`;
  return createHash('sha256').update(key + salt).digest().readUInt32BE(0) / 2 ** 32;
}

/** Looks like a bank reference: "SIM" + 12 hex digits. */
function simulatedReference(providerRef: string): string {
  return `SIM${createHash('sha256').update(providerRef).digest('hex').slice(0, 12).toUpperCase()}`;
}
