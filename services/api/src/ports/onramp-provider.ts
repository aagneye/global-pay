import type { Address, Hex } from 'viem';
import type { FiatAmount } from '../domain/money.js';

export interface OnrampCheckout {
  /** Our order ID; the partner echoes it back (MoonPay's externalTransactionId). */
  orderId: string;
  /** From our user record, never from the request. */
  walletAddress: Address;
  fiat: FiatAmount;
}

/** What the partner says about the purchase for one of our orders. `raw` is kept for debugging. */
export interface OnrampResult {
  /**
   * waiting: the user hasn't paid yet. pending: paying or sending. completed: the partner says it sent
   * the tokens (we still check the chain). failed: definitely not happening.
   */
  status: 'waiting' | 'pending' | 'completed' | 'failed';
  providerTxId: string;
  providerStatus: string;
  /** Where the partner is sending the tokens. */
  walletAddress?: Address;
  /** Token base units the partner sends, once it knows. */
  tokenAmount?: bigint;
  /** The delivering transaction, once sent. */
  txHash?: Hex;
  failureReason?: string;
  raw?: unknown;
}

/** Which order a webhook is about, once its signature is checked. */
export interface OnrampWebhookRef {
  orderId?: string;
}

/**
 * Sells the user USDC for baht and sends it to their wallet.
 * Sandbox and production: MoonPay. Local: SimulatedOnrampProvider (mints test USDC on anvil).
 */
export interface OnrampProvider {
  readonly name: string;
  /** The page the app opens to pay. May be relative to the API's base URL (the local simulator). */
  checkoutUrl(order: OnrampCheckout): string;
  /** The partner's purchase for our order, or null if the user hasn't started one. Throws when unreachable. */
  findByOrderId(orderId: string): Promise<OnrampResult | null>;
  /** Checks a webhook's signature (and age) against the raw body; null if it isn't authentic. */
  parseWebhook?(headers: Record<string, string | string[] | undefined>, rawBody: string, now: Date): OnrampWebhookRef | null;
}
