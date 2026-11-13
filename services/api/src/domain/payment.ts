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

/**
 * The merchant payout's outcome, as the partner reports it.
 *
 *   PENDING ──▶ SUCCEEDED ──▶ REVERSED
 *      │  ▲
 *      ▼  │
 *    UNKNOWN ──▶ SUCCEEDED | FAILED
 *      │
 *      ▼
 *    FAILED
 *
 * - SUCCEEDED: the partner confirmed the merchant was paid, with a bank reference. Only this settles.
 * - FAILED: the partner definitely didn't pay. Only this refunds.
 * - UNKNOWN: we can't tell (timeouts, errors, pending too long, success without a reference).
 *   Nothing happens automatically: it's re-checked, then an operator decides.
 * - REVERSED: the partner undid a payout it had reported as paid. An operator case.
 */
export const PAYOUT_STATUSES = ['PENDING', 'SUCCEEDED', 'FAILED', 'UNKNOWN', 'REVERSED'] as const;

export type PayoutStatus = (typeof PAYOUT_STATUSES)[number];

const PAYOUT_TRANSITIONS: Record<PayoutStatus, readonly PayoutStatus[]> = {
  PENDING: ['SUCCEEDED', 'FAILED', 'UNKNOWN'],
  UNKNOWN: ['PENDING', 'SUCCEEDED', 'FAILED'],
  SUCCEEDED: ['REVERSED'],
  FAILED: [],
  REVERSED: [],
};

export function canTransitionPayout(from: PayoutStatus, to: PayoutStatus): boolean {
  return PAYOUT_TRANSITIONS[from].includes(to);
}

export function assertPayoutTransition(from: PayoutStatus, to: PayoutStatus): void {
  if (!canTransitionPayout(from, to)) {
    throw new AppError('invalid_payout_transition', `Payout cannot move from ${from} to ${to}`, 409);
  }
}

/** The local-currency payout to the merchant, one per payment. */
export interface Payout {
  paymentId: string;
  provider: string;
  /** Sent with every create call, so retrying can never pay twice. */
  idempotencyKey: string;
  /** The partner's ID for the payout, once it accepted it. */
  providerRef?: string;
  /** The bank or rail reference proving the merchant was paid (Thai equivalent of a UTR). */
  providerReference?: string;
  /** The partner's own status word, for audit. */
  providerStatus?: string;
  status: PayoutStatus;
  amount: FiatAmount;
  attempts: number;
  failureReason?: string;
  /** The last error while handling this payout (partner or chain), for operators. */
  lastError?: string;
  lastCheckedAt?: Date;
  /** When to ask the partner again (backoff). */
  nextCheckAt?: Date;
  /** When it became UNKNOWN; after a while it goes to an operator. */
  unknownSince?: Date;
  createdAt: Date;
  updatedAt: Date;
}

/** One partner response, webhook or operator action on a payout, kept for audit. */
export interface PayoutEvent {
  paymentId: string;
  source: 'create' | 'check' | 'webhook' | 'ops';
  providerStatus?: string;
  payload: unknown;
  createdAt: Date;
}
