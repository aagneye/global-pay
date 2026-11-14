import type { FiatAmount } from './money.js';
import type { PromptPayQr } from './promptpay.js';

/**
 * A parsed Indian UPI QR: `upi://pay?pa=<vpa>&pn=<name>&am=<amount>&cu=INR&mc=<code>&tr=<ref>&tn=<note>`.
 * A merchant category code (`mc`) makes it a merchant QR; without one it pays a person.
 */
export interface UpiMerchant {
  kind: 'upi';
  /** The original payload, kept for audit. */
  raw: string;
  /** The payee's UPI ID (`pa`), e.g. "chai.stall@okaxis". */
  vpa: string;
  /** The payee's name (`pn`). */
  name?: string;
  /** Fixed by the QR (`am`), in INR paise; absent on a static QR. */
  amount?: FiatAmount;
  /** Merchant category code (`mc`): present on merchant QRs. */
  merchantCode?: string;
  /** Transaction reference (`tr`). */
  reference?: string;
  /** Note (`tn`). */
  note?: string;
}

/** Who gets paid: a Thai PromptPay QR or an Indian UPI QR. */
export type Merchant = PromptPayQr | UpiMerchant;

/** A personal QR (PromptPay tag 29, or UPI without a merchant code) rather than a merchant's. */
export function isPersonalQr(merchant: Merchant): boolean {
  return merchant.kind === 'upi' ? merchant.merchantCode === undefined : merchant.kind === 'personal';
}
