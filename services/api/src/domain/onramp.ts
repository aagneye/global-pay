import type { Address, Hex } from 'viem';
import { AppError } from '../shared/errors.js';
import type { FiatAmount } from './money.js';

/**
 * An "Add money" order: the user buys USDC with baht through an onramp partner (MoonPay).
 *
 *   CREATED ──▶ PENDING ──▶ COMPLETED   (USDC seen on-chain, in the user's wallet)
 *      │           │
 *      │           └──────▶ FAILED      (the partner says it failed)
 *      └──▶ EXPIRED ──▶ PENDING / COMPLETED / FAILED (the partner turned up after all)
 *
 * COMPLETED needs proof on-chain: a confirmed token transfer to the user's wallet for the amount the
 * partner reported, counted once. The partner saying "completed" only moves the order to PENDING.
 */
export const ONRAMP_STATUSES = ['CREATED', 'PENDING', 'COMPLETED', 'FAILED', 'EXPIRED'] as const;
export type OnrampStatus = (typeof ONRAMP_STATUSES)[number];

const ONRAMP_TRANSITIONS: Record<OnrampStatus, readonly OnrampStatus[]> = {
  CREATED: ['PENDING', 'COMPLETED', 'FAILED', 'EXPIRED'],
  PENDING: ['COMPLETED', 'FAILED'],
  EXPIRED: ['PENDING', 'COMPLETED', 'FAILED'],
  COMPLETED: [],
  FAILED: [],
};

export function canTransitionOnramp(from: OnrampStatus, to: OnrampStatus): boolean {
  return ONRAMP_TRANSITIONS[from].includes(to);
}

export function assertOnrampTransition(from: OnrampStatus, to: OnrampStatus): void {
  if (!canTransitionOnramp(from, to)) {
    throw new AppError('invalid_onramp_transition', `An order cannot move from ${from} to ${to}`, 409);
  }
}

export const isOpenOnramp = (status: OnrampStatus) => status === 'CREATED' || status === 'PENDING';

export interface OnrampOrder {
  id: string;
  userId: string;
  /** Partner name, e.g. "moonpay". */
  provider: string;
  /** Lowercase. Taken from the user's record when the order is made, never from the request. */
  walletAddress: Address;
  fiat: FiatAmount;
  status: OnrampStatus;
  providerTxId?: string;
  providerStatus?: string;
  /** Token base units the partner says it sent. */
  expectedTokenAmount?: bigint;
  /** The delivering transfer: transaction, log index and amount, once verified on-chain. */
  txHash?: Hex;
  logIndex?: number;
  receivedAmount?: bigint;
  failureReason?: string;
  /** The last problem checking the order (shown, not final). */
  lastError?: string;
  lastCheckedAt?: Date;
  expiresAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

/** Token that arrived in a user's wallet from outside: another wallet, an exchange, or the onramp. */
export interface Deposit {
  id: string;
  userId: string;
  chainId: number;
  /** Lowercase. */
  token: Address;
  txHash: Hex;
  logIndex: number;
  from: Address;
  amount: bigint;
  blockNumber: bigint;
  createdAt: Date;
}
