import type { Address } from 'viem';
import type { SignedQuote } from '../domain/quote.js';
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

export interface QuoteRepository {
  create(userId: string, signed: SignedQuote): Promise<void>;
}

export interface PaymentRepository {
  /** Total fiat (minor units) of the user's payments created since `since`, excluding FAILED and REFUNDED. */
  sumFiatSince(userId: string, since: Date): Promise<bigint>;
}

export interface Repositories {
  users: UserRepository;
  nonces: SiweNonceRepository;
  kyc: KycRepository;
  quotes: QuoteRepository;
  payments: PaymentRepository;
}
