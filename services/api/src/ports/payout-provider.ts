import type { FiatAmount } from '../domain/money.js';
import type { PromptPayQr } from '../domain/promptpay.js';

export interface PayoutRequest {
  /** Our payment ID, used as the idempotency key with the partner. */
  paymentId: string;
  merchant: PromptPayQr;
  amount: FiatAmount;
}

export type PayoutResult =
  | { status: 'pending'; providerRef: string }
  | { status: 'succeeded'; providerRef: string }
  | { status: 'failed'; providerRef?: string; reason: string };

/**
 * Pays the merchant in local currency.
 * Demo: SimulatedPromptPayProvider. Production: a licensed Thai e-money operator.
 * createPayout must be idempotent per paymentId.
 */
export interface PayoutProvider {
  readonly name: string;
  createPayout(request: PayoutRequest): Promise<PayoutResult>;
  getPayout(providerRef: string): Promise<PayoutResult>;
}
