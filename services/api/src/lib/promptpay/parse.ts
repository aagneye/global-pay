import type { PromptPayQr } from '../../domain/promptpay.js';
import { AppError, NotImplementedError } from '../../shared/errors.js';

/** Error codes shared with packages/fixtures/promptpay/vectors.json. */
export type PromptPayErrorCode =
  | 'missing_crc'
  | 'crc_mismatch'
  | 'malformed_tlv'
  | 'not_promptpay'
  | 'unsupported_currency';

export class PromptPayParseError extends AppError {
  readonly reason: PromptPayErrorCode;

  constructor(reason: PromptPayErrorCode, message: string) {
    super('invalid_qr', message, 422);
    this.name = 'PromptPayParseError';
    this.reason = reason;
  }
}

/**
 * Parse and validate an EMVCo PromptPay payload.
 * Checks run in the order documented in packages/fixtures/README.md:
 * CRC present and valid → TLV well formed → PromptPay tag 29/30 → currency THB (764).
 */
export function parsePromptPayQr(_payload: string): PromptPayQr {
  throw new NotImplementedError('PromptPay parser', 3);
}
