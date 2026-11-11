import type { FiatAmount } from './money.js';

/** How the PromptPay payee is identified. */
export type PromptPayTargetType = 'mobile' | 'nationalId' | 'eWallet' | 'biller';

/** A parsed Thai PromptPay QR (EMVCo). Field meanings match packages/fixtures/promptpay. */
export interface PromptPayQr {
  /** The original payload, kept for audit. */
  raw: string;
  /** `static`: reusable, no amount. `dynamic`: carries an amount, single use. */
  initiation: 'static' | 'dynamic';
  /** `merchant`: bill payment (tag 30). `personal`: credit transfer (tag 29). */
  kind: 'personal' | 'merchant';
  targetType: PromptPayTargetType;
  targetId: string;
  reference1?: string;
  reference2?: string;
  amount?: FiatAmount;
  merchantName?: string;
  merchantCity?: string;
}
