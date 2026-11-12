import { PrismaPg } from '@prisma/adapter-pg';
import type { Address, Hex } from 'viem';
import type { SignedQuote } from '../../domain/quote.js';
import type { KycRecord, KycTier, User } from '../../domain/user.js';
import { PrismaClient } from '../../generated/prisma/client.js';
import type {
  KycRepository,
  PaymentRepository,
  QuoteRepository,
  Repositories,
  SiweNonceRepository,
  UserRepository,
} from '../../ports/repositories.js';

/** Prisma 7 talks to Postgres through the `pg` driver adapter. Nothing connects until the first query. */
export function createPrismaClient(databaseUrl: string): PrismaClient {
  return new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl }) });
}

export function createPrismaRepositories(prisma: PrismaClient): Repositories {
  return {
    users: new PrismaUserRepository(prisma),
    nonces: new PrismaSiweNonceRepository(prisma),
    kyc: new PrismaKycRepository(prisma),
    quotes: new PrismaQuoteRepository(prisma),
    payments: new PrismaPaymentRepository(prisma),
  };
}

const lower = <T extends string>(value: T) => value.toLowerCase() as T;

function toUser(row: { id: string; walletAddress: string }): User {
  return { id: row.id, walletAddress: row.walletAddress as Address };
}

export class PrismaUserRepository implements UserRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async upsertByWallet(walletAddress: Address): Promise<User> {
    const address = lower(walletAddress);
    const row = await this.prisma.user.upsert({
      where: { walletAddress: address },
      create: { walletAddress: address },
      update: {},
    });
    return toUser(row);
  }

  async findById(id: string): Promise<User | null> {
    const row = await this.prisma.user.findUnique({ where: { id } });
    return row && toUser(row);
  }
}

export class PrismaSiweNonceRepository implements SiweNonceRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async create(nonce: { nonce: string; address: Address; expiresAt: Date }): Promise<void> {
    await this.prisma.siweNonce.create({
      data: { nonce: nonce.nonce, address: lower(nonce.address), expiresAt: nonce.expiresAt },
    });
  }

  async consume(nonce: string, address: Address, now: Date): Promise<boolean> {
    // A single conditional UPDATE: two concurrent sign-ins can't both succeed.
    const { count } = await this.prisma.siweNonce.updateMany({
      where: { nonce, address: lower(address), usedAt: null, expiresAt: { gt: now } },
      data: { usedAt: now },
    });
    return count === 1;
  }
}

export class PrismaKycRepository implements KycRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async find(userId: string): Promise<KycRecord | null> {
    const row = await this.prisma.kycRecord.findUnique({ where: { userId } });
    return row && toKycRecord(row);
  }

  async save(record: KycRecord): Promise<KycRecord> {
    const data = {
      provider: record.provider,
      providerRef: record.providerRef ?? null,
      tier: record.tier,
      status: record.status,
    };
    const row = await this.prisma.kycRecord.upsert({
      where: { userId: record.userId },
      create: { userId: record.userId, ...data },
      update: data,
    });
    return toKycRecord(row);
  }
}

function toKycRecord(row: {
  userId: string;
  provider: string;
  providerRef: string | null;
  tier: number;
  status: KycRecord['status'];
}): KycRecord {
  return {
    userId: row.userId,
    provider: row.provider,
    ...(row.providerRef === null ? {} : { providerRef: row.providerRef }),
    tier: row.tier as KycTier,
    status: row.status,
  };
}

export class PrismaQuoteRepository implements QuoteRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async create(userId: string, { quote, signature }: SignedQuote): Promise<void> {
    await this.prisma.quote.create({
      data: {
        id: lower(quote.quoteId),
        userId,
        payer: lower(quote.payer),
        token: lower(quote.token),
        tokenAmount: quote.tokenAmount,
        fiatCurrency: quote.fiat.currency,
        fiatAmount: quote.fiat.minor,
        rateE8: quote.rateE8,
        spreadBps: quote.spreadBps,
        merchantKind: quote.merchant.kind,
        merchantRef: quote.merchantRef,
        merchantRefHash: lower(quote.merchantRefHash),
        merchantName: quote.merchant.merchantName ?? null,
        qrPayload: quote.merchant.raw,
        signature: lower(signature as Hex),
        expiresAt: quote.expiresAt,
      },
    });
  }
}

export class PrismaPaymentRepository implements PaymentRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async sumFiatSince(userId: string, since: Date): Promise<bigint> {
    const result = await this.prisma.quote.aggregate({
      _sum: { fiatAmount: true },
      where: {
        userId,
        payment: { is: { createdAt: { gte: since }, status: { notIn: ['FAILED', 'REFUNDED'] } } },
      },
    });
    return result._sum.fiatAmount ?? 0n;
  }
}
