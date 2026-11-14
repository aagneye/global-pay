import type { Merchant } from '../domain/merchant.js';
import { merchantRef as promptPayMerchantRef } from './promptpay/merchant-ref.js';
import { parsePromptPayQr } from './promptpay/parse.js';
import { upiMerchantRef } from './upi/merchant-ref.js';
import { isUpiQr, parseUpiQr } from './upi/parse.js';

/** A scanned QR: a UPI link (`upi://pay?...`, any case) or a PromptPay EMVCo QR. Throws 422 if it's neither. */
export function parseMerchantQr(payload: string): Merchant {
  return isUpiQr(payload) ? parseUpiQr(payload) : parsePromptPayQr(payload);
}

/** The merchant's normalised payee reference: "promptpay:<type>:<id>" or "upi:<vpa>". */
export function merchantRefOf(merchant: Merchant): string {
  return merchant.kind === 'upi' ? upiMerchantRef(merchant.vpa) : promptPayMerchantRef(merchant);
}
