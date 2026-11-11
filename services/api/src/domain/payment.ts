import type { Hex } from 'viem';
import { AppError } from '../shared/errors.js';

/**
 * Off-chain payment lifecycle (Prisma enum `PaymentStatus` uses the same names).
 *
 *   SUBMITTED ─▶ PAID ─▶ PAYOUT_PENDING ─▶ SETTLED
 *       │                      │
 *       └─▶ FAILED             └─▶ REFUNDED
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
  settleTxHash?: Hex;
  refundTxHash?: Hex;
  createdAt: Date;
  updatedAt: Date;
}
