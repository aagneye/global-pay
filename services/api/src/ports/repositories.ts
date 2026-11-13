import type { Address, Hex } from 'viem';
import type { FiatAmount } from '../domain/money.js';
import type { Payment, PaymentStatus, Payout, PayoutEvent, PayoutStatus } from '../domain/payment.js';
import type { Quote, SignedQuote } from '../domain/quote.js';
import type { KycRecord, User } from '../domain/user.js';

/** Storage for users. Wallet addresses are stored lowercase. */
export interface UserRepository {
  /** Returns the user for a wallet, creating them on first sign-in. */
  upsertByWallet(walletAddress: Address): Promise<User>;
  findById(id: string): Promise<User | null>;
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
}
