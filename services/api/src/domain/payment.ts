import type { Hex } from 'viem';
import type { FiatAmount } from './money.js';
import { AppError } from '../shared/errors.js';

/**
 * Off-chain payment lifecycle (Prisma enum `PaymentStatus` uses the same names).
 *
 *   SUBMITTED ─▶ PAID ─▶ PAYOUT_PENDING ─▶ SETTLED
 *       │                      │
 *       └─▶ FAILED             └─▶ REFUNDED
 *
 * - SUBMITTED: pay() was sent (or its sending is being confirmed).
 * - PAID: the indexer saw PaymentReceived. The user's USDC is in the contract.
 * - PAYOUT_PENDING: the payout partner was asked to pay the merchant.
 * - SETTLED / REFUNDED: markSettled / refund confirmed on-chain.
 * - FAILED: pay() reverted, or never landed before the quote expired. No funds moved.
 */
export const PAYMENT_STATUSES = [
  'SUBMITTED',
  'PAID',
  'PAYOUT_PENDING',
  'SETTLED',
  'REFUNDED',
  'FAILED',
] as const;

export type PaymentStatus = (typeof PAYMENT_STATUSES)[number];

const TRANSITIONS: Record<PaymentStatus, readonly PaymentStatus[]> = {
  SUBMITTED: ['PAID', 'FAILED'],
  PAID: ['PAYOUT_PENDING'],
  PAYOUT_PENDING: ['SETTLED', 'REFUNDED'],
  SETTLED: [],
  REFUNDED: [],
  FAILED: [],
};

export class InvalidTransitionError extends AppError {
  constructor(from: PaymentStatus, to: PaymentStatus) {
    super('invalid_payment_transition', `Payment cannot move from ${from} to ${to}`, 409);
    this.name = 'InvalidTransitionError';
  }
}

export function canTransition(from: PaymentStatus, to: PaymentStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

export function assertTransition(from: PaymentStatus, to: PaymentStatus): void {
  if (!canTransition(from, to)) throw new InvalidTransitionError(from, to);
}

export function isTerminal(status: PaymentStatus): boolean {
  return TRANSITIONS[status].length === 0;
}

export interface Payment {
  id: string;
  quoteId: Hex;
  userId: string;
  status: PaymentStatus;
  payTxHash?: Hex;
  /** Block of the PaymentReceived event. */
  paidBlock?: bigint;
  settleTxHash?: Hex;
  refundTxHash?: Hex;
  /** Why the payment FAILED, or why it was refunded. */
  failureReason?: string;
  createdAt: Date;
  updatedAt: Date;
}

export type PayoutStatus = 'PENDING' | 'SUCCEEDED' | 'FAILED';

/** The local-currency payout to the merchant, one per payment. */
export interface Payout {
  paymentId: string;
  provider: string;
  /** The partner's ID for the payout, once it accepted it. */
  providerRef?: string;
  status: PayoutStatus;
  amount: FiatAmount;
  attempts: number;
  failureReason?: string;
}
