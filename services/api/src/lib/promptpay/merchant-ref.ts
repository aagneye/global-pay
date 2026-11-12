import { type Hex, keccak256, stringToBytes } from 'viem';
import type { PromptPayQr } from '../../domain/promptpay.js';

/**
 * Normalised payee reference, e.g. "promptpay:biller:099999999999901".
 * It names who gets paid, not which bill: references and amounts live in the stored QR payload.
 */
export function merchantRef(qr: Pick<PromptPayQr, 'targetType' | 'targetId'>): string {
  return `promptpay:${qr.targetType}:${qr.targetId}`;
}

/** keccak256 of the merchant reference: the `merchantRefHash` that goes on-chain in the quote. */
export function merchantRefHash(ref: string): Hex {
  return keccak256(stringToBytes(ref));
}
