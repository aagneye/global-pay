import type { Address, Hex } from 'viem';
import type { FiatAmount } from '../domain/money.js';
import type { Deposit, OnrampOrder, OnrampStatus } from '../domain/onramp.js';
import type { Device, P2pStatus, PaymentRequest } from '../domain/p2p.js';
import type { Payment, PaymentStatus, Payout, PayoutEvent, PayoutStatus } from '../domain/payment.js';
import type { Quote, SignedQuote } from '../domain/quote.js';
import type { KycRecord, User } from '../domain/user.js';

/** Storage for users. Wallet addresses are stored lowercase. */
export interface UserRepository {
  /** Returns the user for a wallet, creating them on first sign-in. */
  upsertByWallet(walletAddress: Address): Promise<User>;
  findById(id: string): Promise<User | null>;
  /** Every user's wallet, for the deposit watcher. */
  listWallets(): Promise<User[]>;
  /** Sets the name others see. It's the user's own word, so it's never marked verified here. */
  updateProfile(id: string, profile: { displayName: string }): Promise<User>;
}

/** One-time nonces for Sign-In with Ethereum. */
export interface SiweNonceRepository {
  create(nonce: { nonce: string; address: Address; expiresAt: Date }): Promise<void>;
  /**
   * Marks the nonce used if it was issued to `address`, is unused and hasn't expired.
   * Returns false otherwise. Must be atomic, so a nonce can only ever sign in once.
   */
  consume(nonce: string, address: Address, now: Date): Promise<boolean>;
}

export interface KycRepository {
  find(userId: string): Promise<KycRecord | null>;
  /** Creates or replaces the user's record. */
  save(record: KycRecord): Promise<KycRecord>;
}

/** A quote as stored: who asked for it, and the backend's signature. */
export interface StoredQuote {
  userId: string;
  quote: Quote;
  signature: Hex;
}

export interface QuoteRepository {
  create(userId: string, signed: SignedQuote): Promise<void>;
  findById(quoteId: Hex): Promise<StoredQuote | null>;
}

export interface PaymentWithQuote {
  payment: Payment;
  quote: StoredQuote;
  /** Once the payout worker has started it. */
  payout?: Payout;
}

/** Fields that change without a status change, or alongside one. */
export type PaymentFields = Partial<
  Pick<Payment, 'payTxHash' | 'paidBlock' | 'settleTxHash' | 'refundTxHash' | 'failureReason'>
>;

export interface PaymentRepository {
  /** Total fiat (minor units) of the user's payments created since `since`, excluding FAILED and REFUNDED. */
  sumFiatSince(userId: string, since: Date): Promise<bigint>;
  /** Creates the SUBMITTED payment for a quote. There's one payment per quote: if it exists, returns it. */
  createForQuote(quoteId: Hex, userId: string): Promise<{ payment: Payment; created: boolean }>;
  findById(id: string): Promise<PaymentWithQuote | null>;
  findByQuoteId(quoteId: Hex): Promise<Payment | null>;
  /** Newest first. */
  listByUser(userId: string, limit: number): Promise<PaymentWithQuote[]>;
  /** Oldest first, for the workers. */
  listByStatus(statuses: readonly PaymentStatus[], limit: number): Promise<PaymentWithQuote[]>;
  update(id: string, fields: PaymentFields): Promise<void>;
  /**
   * Moves the payment from `from` to `to`, setting `fields`, only if it's still in `from`.
   * Returns false if something else moved it first. Throws on a transition the state machine forbids.
   */
  transition(id: string, from: PaymentStatus, to: PaymentStatus, fields?: PaymentFields): Promise<boolean>;
}

/** Payout fields that change alongside, or without, a status change. `null` clears a field. */
export type PayoutFields = {
  [K in
    | 'providerRef'
    | 'providerReference'
    | 'providerStatus'
    | 'failureReason'
    | 'lastError'
    | 'lastCheckedAt'
    | 'nextCheckAt'
    | 'unknownSince']?: Exclude<Payout[K], undefined> | null;
} & { attempts?: number };

export interface PayoutRepository {
  findByPaymentId(paymentId: string): Promise<Payout | null>;
  findByIdempotencyKey(idempotencyKey: string): Promise<Payout | null>;
  /** Creates the payment's PENDING payout, or returns the existing one. */
  createForPayment(payout: {
    paymentId: string;
    provider: string;
    amount: FiatAmount;
    idempotencyKey: string;
  }): Promise<Payout>;
  update(paymentId: string, fields: PayoutFields): Promise<Payout>;
  /**
   * Moves the payout from `from` to `to` (setting `fields`) only if it's still in `from`.
   * Returns false if something else moved it first. Throws on a transition the domain forbids.
   */
  transition(paymentId: string, from: PayoutStatus, to: PayoutStatus, fields?: PayoutFields): Promise<boolean>;
  /** Oldest first. */
  listByStatus(statuses: readonly PayoutStatus[], limit: number): Promise<Payout[]>;
  /** UNKNOWN or REVERSED payouts, and any with an error recorded. Oldest first. */
  listNeedingAttention(limit: number): Promise<Payout[]>;
  countByStatus(): Promise<Record<PayoutStatus, number>>;
  recordEvent(paymentId: string, event: Omit<PayoutEvent, 'paymentId' | 'createdAt'>): Promise<void>;
  /** Newest first. */
  listEvents(paymentId: string, limit: number): Promise<PayoutEvent[]>;
}

/** Something an operator did, for the audit log. */
export interface OpsAction {
  id: string;
  action: string;
  targetType: string;
  targetId: string;
  actor: string;
  note?: string;
  details?: unknown;
  createdAt: Date;
}

export interface OpsActionRepository {
  record(action: Omit<OpsAction, 'id' | 'createdAt'>): Promise<OpsAction>;
  /** Newest first, optionally for one target. */
  list(limit: number, target?: { type: string; id: string }): Promise<OpsAction[]>;
}

/** Where each indexer stopped, so it resumes there after a restart. */
export interface CursorRepository {
  /** The last fully processed block, or null if the indexer never ran. */
  get(id: string): Promise<bigint | null>;
  set(id: string, lastBlock: bigint): Promise<void>;
}

export interface Repositories {
  users: UserRepository;
  nonces: SiweNonceRepository;
  kyc: KycRepository;
  quotes: QuoteRepository;
  payments: PaymentRepository;
  payouts: PayoutRepository;
  cursors: CursorRepository;
  opsActions: OpsActionRepository;
  onrampOrders: OnrampOrderRepository;
  deposits: DepositRepository;
  devices: DeviceRepository;
  paymentRequests: PaymentRequestRepository;
}

/** Order fields that change alongside, or without, a status change. `null` clears a field. */
export type OnrampFields = {
  [K in
    | 'providerTxId'
    | 'providerStatus'
    | 'expectedTokenAmount'
    | 'txHash'
    | 'logIndex'
    | 'receivedAmount'
    | 'failureReason'
    | 'lastError'
    | 'lastCheckedAt']?: Exclude<OnrampOrder[K], undefined> | null;
};

export interface OnrampOrderRepository {
  create(order: Pick<OnrampOrder, 'userId' | 'provider' | 'walletAddress' | 'fiat' | 'expiresAt'>): Promise<OnrampOrder>;
  findById(id: string): Promise<OnrampOrder | null>;
  /** Newest first. */
  listByUser(userId: string, limit: number): Promise<OnrampOrder[]>;
  /** Oldest first. */
  listByStatus(statuses: readonly OnrampStatus[], limit: number): Promise<OnrampOrder[]>;
  /** CREATED or PENDING orders of this user. */
  countOpen(userId: string): Promise<number>;
  update(id: string, fields: OnrampFields): Promise<OnrampOrder>;
  /**
   * Moves the order from `from` to `to` only if it's still in `from`; false if something else moved it.
   * Throws `transfer_already_counted` (409) if another order already has this txHash and logIndex.
   */
  transition(id: string, from: OnrampStatus, to: OnrampStatus, fields?: OnrampFields): Promise<boolean>;
}

export interface DepositRepository {
  /** Stores a deposit once per chain, transaction and log; false if it was already stored. */
  record(deposit: Omit<Deposit, 'id' | 'createdAt'>): Promise<boolean>;
  /** Newest first, in chain order (block, then log). */
  listByUser(userId: string, limit: number): Promise<Deposit[]>;
}

export interface DeviceRepository {
  /**
   * Registers a phone, or refreshes its push token if this user already has it (un-revoking it).
   * Throws `device_taken` (409) if another user registered the same key.
   */
  register(device: { userId: string; publicKey: string; platform: string; fcmToken?: string }): Promise<Device>;
  findById(id: string): Promise<Device | null>;
  /** The user's devices that aren't revoked. */
  listActive(userId: string): Promise<Device[]>;
  /** Drops a push token the push service says is no longer valid. */
  forgetPushToken(fcmToken: string): Promise<void>;
  /** False if the user has no such device. */
  revoke(id: string, userId: string, now: Date): Promise<boolean>;
}

/** Request fields that change alongside a status change. `null` clears a field. */
export type P2pFields = { txHash?: PaymentRequest['txHash'] | null; failureReason?: string | null };

export interface PaymentRequestRepository {
  create(
    request: Pick<
      PaymentRequest,
      'receiverId' | 'receiverAddress' | 'recipientName' | 'nameVerified' | 'token' | 'amount' | 'nonce' | 'challenge' | 'validBefore' | 'expiresAt'
    >,
  ): Promise<PaymentRequest>;
  findById(id: string): Promise<PaymentRequest | null>;
  /**
   * Sets the sender and uses up the challenge, in one conditional update: only while the request is
   * CREATED, unexpired and its challenge unused. False otherwise (someone got there first, or too late).
   */
  identifySender(id: string, sender: { senderId: string; senderAddress: string; senderDeviceId?: string }, now: Date): Promise<boolean>;
  /** Moves the request only if it's still in `from`; false if something else moved it first. */
  transition(id: string, from: P2pStatus, to: P2pStatus, fields?: P2pFields): Promise<boolean>;
  /** CREATED or SENDER_IDENTIFIED requests this user is receiving. */
  countOpenByReceiver(receiverId: string): Promise<number>;
  /** Unexpired requests waiting for this sender's approval, newest first. */
  listAwaitingSender(senderId: string, now: Date): Promise<PaymentRequest[]>;
  /** Requests this user received or sent, newest first. */
  listByUser(userId: string, limit: number): Promise<PaymentRequest[]>;
  /** Oldest first. */
  listByStatus(statuses: readonly P2pStatus[], limit: number): Promise<PaymentRequest[]>;
}
