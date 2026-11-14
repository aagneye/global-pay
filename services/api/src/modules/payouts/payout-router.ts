import type { Merchant } from '../../domain/merchant.js';
import type { PayoutProvider } from '../../ports/payout-provider.js';

/**
 * Picks the payout partner by merchant kind: PromptPay QRs go to the PromptPay partner (PAYOUT_PROVIDER),
 * UPI merchants to the UPI partner. A payout stays with the partner it was created with (by name).
 */
export class PayoutRouter {
  readonly promptpay: PayoutProvider;
  readonly upi?: PayoutProvider;

  constructor(routes: { promptpay: PayoutProvider; upi?: PayoutProvider }) {
    this.promptpay = routes.promptpay;
    if (routes.upi) this.upi = routes.upi;
  }

  /** The partner that pays this merchant, or undefined if none can. */
  forMerchant(merchant: Merchant): PayoutProvider | undefined {
    return merchant.kind === 'upi' ? this.upi : this.promptpay;
  }

  /** The partner with this name (the one a payout was created with). */
  named(name: string): PayoutProvider | undefined {
    return [this.promptpay, this.upi].find((provider) => provider?.name === name);
  }
}
