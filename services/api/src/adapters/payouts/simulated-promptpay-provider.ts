import { createHash } from 'node:crypto';
import type { PayoutProvider, PayoutRequest, PayoutResult } from '../../ports/payout-provider.js';

export interface SimulatedPromptPayOptions {
  /** How long a payout stays `pending` before it resolves. */
  delayMs: number;
  /** Share of payouts that fail (0..1). 1 fails them all, to exercise refunds. */
  failureRate: number;
  now?: () => number;
}

const PREFIX = 'sim';

/**
 * Stand-in for a licensed Thai e-money operator paying a PromptPay QR in THB.
 * No money moves. It only simulates timing and failures.
 *
 * It keeps no state: the reference encodes the payment ID and the start time, and whether a payout
 * fails depends only on its payment ID. So results survive a restart, and the same payment always
 * gets the same outcome.
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

  async createPayout(request: PayoutRequest): Promise<PayoutResult> {
    let providerRef = this.started.get(request.paymentId);
    if (!providerRef) {
      providerRef = `${PREFIX}_${request.paymentId}_${this.now()}`;
      this.started.set(request.paymentId, providerRef);
    }
    if (request.amount.minor <= 0n) return { status: 'failed', providerRef, reason: 'Amount must be positive' };
    return { status: 'pending', providerRef };
  }

  async getPayout(providerRef: string): Promise<PayoutResult> {
    const match = /^sim_(.+)_(\d+)$/.exec(providerRef);
    if (!match?.[1] || !match[2]) return { status: 'failed', providerRef, reason: 'Unknown payout reference' };
    const [, paymentId, startedAt] = match;

    if (this.now() - Number(startedAt) < this.options.delayMs) return { status: 'pending', providerRef };
    if (failureDraw(paymentId) < this.options.failureRate) {
      return { status: 'failed', providerRef, reason: 'Simulated payout failure (PAYOUT_FAILURE_RATE)' };
    }
    return { status: 'succeeded', providerRef };
  }
}

/** A number in [0, 1) fixed by the payment ID. */
function failureDraw(paymentId: string): number {
  return createHash('sha256').update(paymentId).digest().readUInt32BE(0) / 2 ** 32;
}
