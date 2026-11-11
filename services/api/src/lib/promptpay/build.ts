import type { FiatAmount } from '../../domain/money.js';
import type { PromptPayTargetType } from '../../domain/promptpay.js';
import { NotImplementedError } from '../../shared/errors.js';

export interface BuildPromptPayQrInput {
  kind: 'personal' | 'merchant';
  targetType: PromptPayTargetType;
  targetId: string;
  amount?: FiatAmount;
  reference1?: string;
  reference2?: string;
  merchantName?: string;
  merchantCity?: string;
}

/** Build an EMVCo PromptPay payload with CRC. Used for demo QRs and tests. */
export function buildPromptPayQr(_input: BuildPromptPayQrInput): string {
  throw new NotImplementedError('PromptPay QR builder', 3);
}
