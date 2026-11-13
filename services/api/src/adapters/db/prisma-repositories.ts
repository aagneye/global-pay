import { PrismaPg } from '@prisma/adapter-pg';
import { type Address, type Hex, getAddress } from 'viem';
import type { FiatCurrency } from '../../domain/money.js';
import {
  PAYOUT_STATUSES,
  type Payment,
  type PaymentStatus,
  type Payout,
  type PayoutEvent,
  type PayoutStatus,
  assertPayoutTransition,
  assertTransition,
} from '../../domain/payment.js';
import type { SignedQuote } from '../../domain/quote.js';
import type { KycRecord, KycTier, User } from '../../domain/user.js';
import {
  Prisma,
  PrismaClient,
  type Payment as PaymentRow,
  type Payout as PayoutRow,
  type Quote as QuoteRow,
} from '../../generated/prisma/client.js';
import { parsePromptPayQr } from '../../lib/promptpay/parse.js';
import type {
  CursorRepository,
  KycRepository,
  OpsAction,
  OpsActionRepository,
  PaymentFields,
  PaymentRepository,
  PaymentWithQuote,
  PayoutFields,
  PayoutRepository,
  QuoteRepository,
  Repositories,
  SiweNonceRepository,
  StoredQuote,
  UserRepository,
} from '../../ports/repositories.js';

/**
 * Prisma 7 talks to Postgres through the `pg` driver adapter. Nothing connects until the first query.
 * `maxConnections` caps the pool (default 10).
 */
export function createPrismaClient(databaseUrl: string, maxConnections?: number): PrismaClient {
  const pool = maxConnections === undefined ? {} : { max: maxConnections };
  return new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl, ...pool }) });
}

export function createPrismaRepositories(prisma: PrismaClient): Repositories {
  return {
    users: new PrismaUserRepository(prisma),
    nonces: new PrismaSiweNonceRepository(prisma),
    kyc: new PrismaKycRepository(prisma),
    quotes: new PrismaQuoteRepository(prisma),
    payments: new PrismaPaymentRepository(prisma),
    payouts: new PrismaPayoutRepository(prisma),
    cursors: new PrismaCursorRepository(prisma),
    opsActions: new PrismaOpsActionRepository(prisma),
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

  async findById(quoteId: Hex): Promise<StoredQuote | null> {
    const row = await this.prisma.quote.findUnique({ where: { id: lower(quoteId) } });
    return row && toStoredQuote(row);
  }
}

function toStoredQuote(row: QuoteRow): StoredQuote {
  return {
    userId: row.userId,
    signature: row.signature as Hex,
    quote: {
      quoteId: row.id as Hex,
      payer: getAddress(row.payer),
      token: getAddress(row.token),
      tokenAmount: row.tokenAmount,
      fiat: { currency: row.fiatCurrency as FiatCurrency, minor: row.fiatAmount },
      rateE8: row.rateE8,
      spreadBps: row.spreadBps,
      merchantRef: row.merchantRef,
      merchantRefHash: row.merchantRefHash as Hex,
      merchant: parsePromptPayQr(row.qrPayload),
      expiresAt: row.expiresAt,
    },
  };
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

  async createForQuote(quoteId: Hex, userId: string): Promise<{ payment: Payment; created: boolean }> {
    try {
      const row = await this.prisma.payment.create({ data: { quoteId: lower(quoteId), userId } });
      return { payment: toPayment(row), created: true };
    } catch (error) {
      // quoteId is unique, so this is race-free: a second submission gets the first one's payment.
      if (!(error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002')) throw error;
      const row = await this.prisma.payment.findUniqueOrThrow({ where: { quoteId: lower(quoteId) } });
      return { payment: toPayment(row), created: false };
    }
  }

  async findById(id: string): Promise<PaymentWithQuote | null> {
    const row = await this.prisma.payment.findUnique({ where: { id }, include: { quote: true, payout: true } });
    return row && withQuote(row);
  }

  async findByQuoteId(quoteId: Hex): Promise<Payment | null> {
    const row = await this.prisma.payment.findUnique({ where: { quoteId: lower(quoteId) } });
    return row && toPayment(row);
  }

  async listByUser(userId: string, limit: number): Promise<PaymentWithQuote[]> {
    const rows = await this.prisma.payment.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      take: limit,
      include: { quote: true, payout: true },
    });
    return rows.map(withQuote);
  }

  async listByStatus(statuses: readonly PaymentStatus[], limit: number): Promise<PaymentWithQuote[]> {
    const rows = await this.prisma.payment.findMany({
      where: { status: { in: [...statuses] } },
      orderBy: { createdAt: 'asc' },
      take: limit,
      include: { quote: true, payout: true },
    });
    return rows.map(withQuote);
  }

  async update(id: string, fields: PaymentFields): Promise<void> {
    await this.prisma.payment.update({ where: { id }, data: toPaymentData(fields) });
  }

  async transition(id: string, from: PaymentStatus, to: PaymentStatus, fields: PaymentFields = {}): Promise<boolean> {
    assertTransition(from, to);
    // Conditional on the current status, so two workers can't both move the same payment.
    const { count } = await this.prisma.payment.updateMany({
      where: { id, status: from },
      data: { status: to, ...toPaymentData(fields) },
    });
    return count === 1;
  }
}

function toPayment(row: PaymentRow): Payment {
  return {
    id: row.id,
    quoteId: row.quoteId as Hex,
    userId: row.userId,
    status: row.status,
    ...(row.payTxHash === null ? {} : { payTxHash: row.payTxHash as Hex }),
    ...(row.paidBlock === null ? {} : { paidBlock: row.paidBlock }),
    ...(row.settleTxHash === null ? {} : { settleTxHash: row.settleTxHash as Hex }),
    ...(row.refundTxHash === null ? {} : { refundTxHash: row.refundTxHash as Hex }),
    ...(row.failureReason === null ? {} : { failureReason: row.failureReason }),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function withQuote(row: PaymentRow & { quote: QuoteRow; payout: PayoutRow | null }): PaymentWithQuote {
  return {
    payment: toPayment(row),
    quote: toStoredQuote(row.quote),
    ...(row.payout ? { payout: toPayout(row.payout) } : {}),
  };
}

function toPaymentData(fields: PaymentFields) {
  return {
    ...(fields.payTxHash === undefined ? {} : { payTxHash: lower(fields.payTxHash) }),
    ...(fields.paidBlock === undefined ? {} : { paidBlock: fields.paidBlock }),
    ...(fields.settleTxHash === undefined ? {} : { settleTxHash: lower(fields.settleTxHash) }),
    ...(fields.refundTxHash === undefined ? {} : { refundTxHash: lower(fields.refundTxHash) }),
    ...(fields.failureReason === undefined ? {} : { failureReason: fields.failureReason }),
  };
}

export class PrismaPayoutRepository implements PayoutRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async findByPaymentId(paymentId: string): Promise<Payout | null> {
    const row = await this.prisma.payout.findUnique({ where: { paymentId } });
    return row && toPayout(row);
  }

  async findByIdempotencyKey(idempotencyKey: string): Promise<Payout | null> {
    const row = await this.prisma.payout.findUnique({ where: { idempotencyKey } });
    return row && toPayout(row);
  }

  async createForPayment(payout: {
    paymentId: string;
    provider: string;
    amount: Payout['amount'];
    idempotencyKey: string;
  }): Promise<Payout> {
    const row = await this.prisma.payout.upsert({
      where: { paymentId: payout.paymentId },
      create: {
        paymentId: payout.paymentId,
        provider: payout.provider,
        idempotencyKey: payout.idempotencyKey,
        currency: payout.amount.currency,
        amount: payout.amount.minor,
      },
      update: {},
    });
    return toPayout(row);
  }

  async update(paymentId: string, fields: PayoutFields): Promise<Payout> {
    const row = await this.prisma.payout.update({ where: { paymentId }, data: fields });
    return toPayout(row);
  }

  async transition(paymentId: string, from: PayoutStatus, to: PayoutStatus, fields: PayoutFields = {}): Promise<boolean> {
    assertPayoutTransition(from, to);
    // Conditional on the current status, so a webhook and the worker can't both move it.
    const { count } = await this.prisma.payout.updateMany({
      where: { paymentId, status: from },
      data: { ...fields, status: to },
    });
    return count === 1;
  }

  async listByStatus(statuses: readonly PayoutStatus[], limit: number): Promise<Payout[]> {
    const rows = await this.prisma.payout.findMany({
      where: { status: { in: [...statuses] } },
      orderBy: { createdAt: 'asc' },
      take: limit,
    });
    return rows.map(toPayout);
  }

  async listNeedingAttention(limit: number): Promise<Payout[]> {
    const rows = await this.prisma.payout.findMany({
      where: { OR: [{ status: { in: ['UNKNOWN', 'REVERSED'] } }, { lastError: { not: null } }] },
      orderBy: { createdAt: 'asc' },
      take: limit,
    });
    return rows.map(toPayout);
  }

  async countByStatus(): Promise<Record<PayoutStatus, number>> {
    const groups = await this.prisma.payout.groupBy({ by: ['status'], _count: { _all: true } });
    const counts = Object.fromEntries(PAYOUT_STATUSES.map((status) => [status, 0])) as Record<PayoutStatus, number>;
    for (const group of groups) counts[group.status] = group._count._all;
    return counts;
  }

  async recordEvent(paymentId: string, event: Omit<PayoutEvent, 'paymentId' | 'createdAt'>): Promise<void> {
    const payout = await this.prisma.payout.findUniqueOrThrow({ where: { paymentId }, select: { id: true } });
    await this.prisma.payoutEvent.create({
      data: {
        payoutId: payout.id,
        source: event.source,
        providerStatus: event.providerStatus ?? null,
        payload: toJson(event.payload),
      },
    });
  }

  async listEvents(paymentId: string, limit: number): Promise<PayoutEvent[]> {
    const rows = await this.prisma.payoutEvent.findMany({
      where: { payout: { paymentId } },
      orderBy: { createdAt: 'desc' },
      take: limit,
    });
    return rows.map((row) => ({
      paymentId,
      source: row.source as PayoutEvent['source'],
      ...(row.providerStatus === null ? {} : { providerStatus: row.providerStatus }),
      payload: row.payload,
      createdAt: row.createdAt,
    }));
  }
}

function toPayout(row: PayoutRow): Payout {
  return {
    paymentId: row.paymentId,
    provider: row.provider,
    idempotencyKey: row.idempotencyKey,
    ...(row.providerRef === null ? {} : { providerRef: row.providerRef }),
    ...(row.providerReference === null ? {} : { providerReference: row.providerReference }),
    ...(row.providerStatus === null ? {} : { providerStatus: row.providerStatus }),
    status: row.status,
    amount: { currency: row.currency as FiatCurrency, minor: row.amount },
    attempts: row.attempts,
    ...(row.failureReason === null ? {} : { failureReason: row.failureReason }),
    ...(row.lastError === null ? {} : { lastError: row.lastError }),
    ...(row.lastCheckedAt === null ? {} : { lastCheckedAt: row.lastCheckedAt }),
    ...(row.nextCheckAt === null ? {} : { nextCheckAt: row.nextCheckAt }),
    ...(row.unknownSince === null ? {} : { unknownSince: row.unknownSince }),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/** Partner payloads can hold bigints; store them as strings. */
function toJson(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value ?? null, (_key, v) => (typeof v === 'bigint' ? v.toString() : v)));
}

export class PrismaOpsActionRepository implements OpsActionRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async record(action: Omit<OpsAction, 'id' | 'createdAt'>): Promise<OpsAction> {
    const row = await this.prisma.opsAction.create({
      data: {
        action: action.action,
        targetType: action.targetType,
        targetId: action.targetId,
        actor: action.actor,
        note: action.note ?? null,
        ...(action.details === undefined ? {} : { details: toJson(action.details) }),
      },
    });
    return toOpsAction(row);
  }

  async list(limit: number, target?: { type: string; id: string }): Promise<OpsAction[]> {
    const rows = await this.prisma.opsAction.findMany({
      where: target ? { targetType: target.type, targetId: target.id } : {},
      orderBy: { createdAt: 'desc' },
      take: limit,
    });
    return rows.map(toOpsAction);
  }
}

function toOpsAction(row: {
  id: string;
  action: string;
  targetType: string;
  targetId: string;
  actor: string;
  note: string | null;
  details: unknown;
  createdAt: Date;
}): OpsAction {
  return {
    id: row.id,
    action: row.action,
    targetType: row.targetType,
    targetId: row.targetId,
    actor: row.actor,
    ...(row.note === null ? {} : { note: row.note }),
    ...(row.details === null ? {} : { details: row.details }),
    createdAt: row.createdAt,
  };
}

export class PrismaCursorRepository implements CursorRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async get(id: string): Promise<bigint | null> {
    const row = await this.prisma.indexerCursor.findUnique({ where: { id } });
    return row?.lastBlock ?? null;
  }

  async set(id: string, lastBlock: bigint): Promise<void> {
    await this.prisma.indexerCursor.upsert({ where: { id }, create: { id, lastBlock }, update: { lastBlock } });
  }
}
