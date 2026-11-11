import type { PayoutProvider, PayoutRequest, PayoutResult } from '../../ports/payout-provider.js';
import { NotImplementedError } from '../../shared/errors.js';

export interface SimulatedPromptPayOptions {
  /** How long a payout stays `pending` before it resolves. */
  delayMs: number;
  /** Probability (0..1) that a payout fails. Set to 1 to exercise refunds. */
  failureRate: number;
}

/**
 * Stand-in for a licensed Thai e-money operator paying a PromptPay QR in THB.
 * No money moves. It only simulates timing and failures.
 */
export class SimulatedPromptPayProvider implements PayoutProvider {
  readonly name = 'simulated-promptpay';
  private readonly options: SimulatedPromptPayOptions;

  constructor(options: SimulatedPromptPayOptions) {
    this.options = options;
  }

  async createPayout(_request: PayoutRequest): Promise<PayoutResult> {
    throw new NotImplementedError('Simulated PromptPay payout', 4);
  }

  async getPayout(_providerRef: string): Promise<PayoutResult> {
    throw new NotImplementedError('Simulated PromptPay payout', 4);
  }
}
