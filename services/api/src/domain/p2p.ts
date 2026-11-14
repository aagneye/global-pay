import type { Address, Hex } from 'viem';
import { AppError } from '../shared/errors.js';

/**
 * A person-to-person payment request (tap to pay, ADR 0010). The receiver asks for an amount; the sender
 * is identified by tapping phones (or scanning the receiver's QR), approves on their own phone, and signs
 * a gasless USDC transfer that the backend relays.
 *
 *   CREATED ──▶ SENDER_IDENTIFIED ──▶ APPROVING ──▶ SUBMITTED ──▶ COMPLETED
 *      │               │    ▲             │                └──────▶ FAILED (the transfer reverted)
 *      │               │    └─────────────┤ (nothing was sent: the sender can try again)
 *      │               ├──▶ DECLINED      └──▶ COMPLETED / FAILED / EXPIRED (see below)
 *      └───────────────┴──▶ EXPIRED (not approved in time) / CANCELLED (by the receiver)
 *
 * APPROVING claims the request while its transfer is relayed, so the receiver can't cancel it and the
 * worker can't expire it under a transfer that lands. The transfer's hash is stored before it's
 * broadcast, so an APPROVING request without a hash has had nothing sent: only then may it go back to
 * SENDER_IDENTIFIED (or EXPIRED). With a hash, its receipt decides, as for SUBMITTED.
 */
export const P2P_STATUSES = [
  'CREATED',
  'SENDER_IDENTIFIED',
  'APPROVING',
  'SUBMITTED',
  'COMPLETED',
  'FAILED',
  'EXPIRED',
  'DECLINED',
  'CANCELLED',
] as const;
export type P2pStatus = (typeof P2P_STATUSES)[number];

const P2P_TRANSITIONS: Record<P2pStatus, readonly P2pStatus[]> = {
  CREATED: ['SENDER_IDENTIFIED', 'EXPIRED', 'CANCELLED'],
  SENDER_IDENTIFIED: ['APPROVING', 'EXPIRED', 'DECLINED', 'CANCELLED'],
  APPROVING: ['SUBMITTED', 'SENDER_IDENTIFIED', 'EXPIRED', 'COMPLETED', 'FAILED'],
  SUBMITTED: ['COMPLETED', 'FAILED'],
  COMPLETED: [],
  FAILED: [],
  EXPIRED: [],
  DECLINED: [],
  CANCELLED: [],
};

export function assertP2pTransition(from: P2pStatus, to: P2pStatus): void {
  if (!P2P_TRANSITIONS[from].includes(to)) {
    throw new AppError('invalid_request_transition', `A request cannot move from ${from} to ${to}`, 409);
  }
}

export const isFinalP2p = (status: P2pStatus) => P2P_TRANSITIONS[status].length === 0;

export interface PaymentRequest {
  id: string;
  receiverId: string;
  /** Lowercase. */
  receiverAddress: Address;
  /** Copied from the receiver's profile when the request is made, never from the request body. */
  recipientName: string;
  nameVerified: boolean;
  /** Lowercase USDC address. */
  token: Address;
  /** Token base units. */
  amount: bigint;
  /** EIP-3009 nonce: random, one per request. */
  nonce: Hex;
  /** One-time challenge the sender's phone signs when tapped (or the QR carries). */
  challenge: Hex;
  challengeUsedAt?: Date;
  senderId?: string;
  senderAddress?: Address;
  /** The device that answered the tap, if it was a tap. */
  senderDeviceId?: string;
  /** EIP-3009 validBefore, unix seconds. */
  validBefore: bigint;
  /** The sender must approve before this. */
  expiresAt: Date;
  status: P2pStatus;
  txHash?: Hex;
  failureReason?: string;
  createdAt: Date;
  updatedAt: Date;
}

/** A phone that can be tapped to pay: its hardware-backed P-256 key and push token. */
export interface Device {
  id: string;
  userId: string;
  /** SPKI DER, base64. */
  publicKey: string;
  fcmToken?: string;
  platform: string;
  createdAt: Date;
  revokedAt?: Date;
}

/** A signed EIP-3009 TransferWithAuthorization, ready to relay. */
export interface TransferAuthorization {
  token: Address;
  from: Address;
  to: Address;
  value: bigint;
  validAfter: bigint;
  validBefore: bigint;
  nonce: Hex;
  signature: Hex;
}

/** What the sender's phone signs, so its key can't be used to sign anything else over NFC. */
export const TAP_SIGNING_PREFIX = 'GLOBALPAY-TAP-1';
