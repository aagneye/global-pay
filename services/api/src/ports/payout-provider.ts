import type { FiatAmount } from '../domain/money.js';
import type { Merchant } from '../domain/merchant.js';

export interface PayoutRequest {
  /** Sent as the partner's idempotency key and our reference, so a retry can never pay twice. */
  idempotencyKey: string;
  paymentId: string;
  merchant: Merchant;
  amount: FiatAmount;
}

/** What the partner says about a payout. `raw` is kept for the audit trail. */
export type PayoutResult = (
  | { status: 'pending'; providerRef: string }
  | {
      status: 'succeeded';
      providerRef: string;
      /** Proof the merchant was paid: the bank or rail reference, else the partner's transaction ID. */
      reference?: string;
    }
  | {
      /** Definitely not paid, so the user can be refunded. */
      status: 'failed';
      providerRef?: string;
      reason: string;
    }
  | {
      /** A payout reported as paid was undone. An operator decides what happens. */
      status: 'reversed';
      providerRef: string;
      reason?: string;
    }
  | {
      /** We can't tell whether the merchant was paid: timeouts, server errors, odd answers. */
      status: 'unknown';
      providerRef?: string;
      reason: string;
    }
) & { providerStatus?: string; raw?: unknown };

/** Who a webhook is about, once its authenticity is checked. */
export interface PayoutWebhookRef {
  providerRef?: string;
  idempotencyKey?: string;
}

/**
 * Pays the merchant in local currency.
 * Demo: SimulatedPromptPayProvider. Sandbox: XenditPayoutProvider.
 * Production: a licensed Thai partner (e.g. Krungsri's corporate API).
 *
 * Calls that only *read* (getPayout, findByIdempotencyKey, getBalance) throw when the partner can't be
 * reached: nothing is decided then. createPayout returns `unknown` when the payout may or may not exist.
 */
export interface PayoutProvider {
  readonly name: string;
  /** Whether this rail can pay this QR at all. Checked when quoting, before any money moves. */
  supports(merchant: Merchant): boolean;
  /** Must be idempotent per `idempotencyKey`. */
  createPayout(request: PayoutRequest): Promise<PayoutResult>;
  getPayout(providerRef: string): Promise<PayoutResult>;
  /** The payout created with this key, or null if the partner has none. Used before retrying a create. */
  findByIdempotencyKey(idempotencyKey: string): Promise<PayoutResult | null>;
  /** Funds available for payouts, or null if the partner doesn't report it. */
  getBalance(): Promise<FiatAmount | null>;
  /** Checks a webhook's authenticity and says which payout it's about; null if it isn't authentic. */
  parseWebhook?(headers: Record<string, string | string[] | undefined>, body: unknown): PayoutWebhookRef | null;
}
