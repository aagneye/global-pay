import type { Address } from 'viem';
import type { SignedQuote } from '../../src/domain/quote.js';
import type { KycRecord, User } from '../../src/domain/user.js';
import type { Repositories } from '../../src/ports/repositories.js';

interface StoredPayment {
  userId: string;
  fiatMinor: bigint;
  status: 'SUBMITTED' | 'PAID' | 'PAYOUT_PENDING' | 'SETTLED' | 'REFUNDED' | 'FAILED';
  createdAt: Date;
}

/** In-memory repositories with the same behaviour as the Prisma ones, for fast unit tests. */
export function createMemoryRepositories() {
  const users = new Map<string, User>();
  const nonces = new Map<string, { address: string; expiresAt: Date; usedAt?: Date }>();
  const kyc = new Map<string, KycRecord>();
  const quotes = new Map<string, { userId: string; signed: SignedQuote }>();
  const payments: StoredPayment[] = [];
  let nextUserId = 1;

  const repositories: Repositories = {
    users: {
      async upsertByWallet(walletAddress) {
        const address = walletAddress.toLowerCase() as Address;
        const existing = [...users.values()].find((user) => user.walletAddress === address);
        if (existing) return existing;
        const user = { id: `user_${nextUserId++}`, walletAddress: address };
        users.set(user.id, user);
        return user;
      },
      async findById(id) {
        return users.get(id) ?? null;
      },
    },
    nonces: {
      async create({ nonce, address, expiresAt }) {
        if (nonces.has(nonce)) throw new Error('duplicate nonce');
        nonces.set(nonce, { address: address.toLowerCase(), expiresAt });
      },
      async consume(nonce, address, now) {
        const stored = nonces.get(nonce);
        if (!stored || stored.usedAt || stored.address !== address.toLowerCase() || stored.expiresAt <= now) {
          return false;
        }
        stored.usedAt = now;
        return true;
      },
    },
    kyc: {
      async find(userId) {
        return kyc.get(userId) ?? null;
      },
      async save(record) {
        kyc.set(record.userId, record);
        return record;
      },
    },
    quotes: {
      async create(userId, signed) {
        const id = signed.quote.quoteId.toLowerCase();
        if (quotes.has(id)) throw new Error('duplicate quote');
        quotes.set(id, { userId, signed });
      },
    },
    payments: {
      async sumFiatSince(userId, since) {
        return payments
          .filter((p) => p.userId === userId && p.createdAt >= since)
          .filter((p) => p.status !== 'FAILED' && p.status !== 'REFUNDED')
          .reduce((sum, p) => sum + p.fiatMinor, 0n);
      },
    },
  };

  return {
    ...repositories,
    /** Test-only views of the stored data. */
    state: { users, nonces, kyc, quotes, payments },
  };
}

export type MemoryRepositories = ReturnType<typeof createMemoryRepositories>;
