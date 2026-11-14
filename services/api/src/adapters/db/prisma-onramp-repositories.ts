import type { Address, Hex } from 'viem';
import type { FiatCurrency } from '../../domain/money.js';
import { type Deposit, type OnrampOrder, type OnrampStatus, assertOnrampTransition } from '../../domain/onramp.js';
import {
  type Deposit as DepositRow,
  type OnrampOrder as OnrampRow,
  Prisma,
  type PrismaClient,
} from '../../generated/prisma/client.js';
import type { DepositRepository, OnrampFields, OnrampOrderRepository } from '../../ports/repositories.js';
import { AppError } from '../../shared/errors.js';

const lower = <T extends string>(value: T) => value.toLowerCase() as T;
const isUniqueViolation = (error: unknown) =>
  error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';

export class PrismaOnrampOrderRepository implements OnrampOrderRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async create(order: Pick<OnrampOrder, 'userId' | 'provider' | 'walletAddress' | 'fiat' | 'expiresAt'>): Promise<OnrampOrder> {
    const row = await this.prisma.onrampOrder.create({
      data: {
        userId: order.userId,
        provider: order.provider,
        walletAddress: lower(order.walletAddress),
        fiatCurrency: order.fiat.currency,
        fiatAmount: order.fiat.minor,
        expiresAt: order.expiresAt,
      },
    });
    return toOrder(row);
  }

  async findById(id: string): Promise<OnrampOrder | null> {
    const row = await this.prisma.onrampOrder.findUnique({ where: { id } });
    return row && toOrder(row);
  }

  async listByUser(userId: string, limit: number): Promise<OnrampOrder[]> {
    const rows = await this.prisma.onrampOrder.findMany({ where: { userId }, orderBy: { createdAt: 'desc' }, take: limit });
    return rows.map(toOrder);
  }

  async listByStatus(statuses: readonly OnrampStatus[], limit: number): Promise<OnrampOrder[]> {
    const rows = await this.prisma.onrampOrder.findMany({
      where: { status: { in: [...statuses] } },
      orderBy: { createdAt: 'asc' },
      take: limit,
    });
    return rows.map(toOrder);
  }

  async countOpen(userId: string): Promise<number> {
    return this.prisma.onrampOrder.count({ where: { userId, status: { in: ['CREATED', 'PENDING'] } } });
  }

  async update(id: string, fields: OnrampFields): Promise<OnrampOrder> {
    return toOrder(await this.prisma.onrampOrder.update({ where: { id }, data: toData(fields) }));
  }

  async transition(id: string, from: OnrampStatus, to: OnrampStatus, fields: OnrampFields = {}): Promise<boolean> {
    assertOnrampTransition(from, to);
    try {
      const { count } = await this.prisma.onrampOrder.updateMany({ where: { id, status: from }, data: { status: to, ...toData(fields) } });
      return count === 1;
    } catch (error) {
      if (isUniqueViolation(error)) throw alreadyCounted();
      throw error;
    }
  }
}

export class PrismaDepositRepository implements DepositRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async record(deposit: Omit<Deposit, 'id' | 'createdAt'>): Promise<boolean> {
    try {
      await this.prisma.deposit.create({
        data: {
          userId: deposit.userId,
          chainId: deposit.chainId,
          token: lower(deposit.token),
          txHash: lower(deposit.txHash),
          logIndex: deposit.logIndex,
          fromAddress: lower(deposit.from),
          amount: deposit.amount,
          blockNumber: deposit.blockNumber,
        },
      });
      return true;
    } catch (error) {
      if (isUniqueViolation(error)) return false;
      throw error;
    }
  }

  async listByUser(userId: string, limit: number): Promise<Deposit[]> {
    const rows = await this.prisma.deposit.findMany({
      where: { userId },
      orderBy: [{ blockNumber: 'desc' }, { logIndex: 'desc' }],
      take: limit,
    });
    return rows.map(toDeposit);
  }
}

export function alreadyCounted(): AppError {
  return new AppError('transfer_already_counted', 'This on-chain transfer already completed another order', 409);
}

function toData(fields: OnrampFields) {
  return {
    ...fields,
    ...(fields.txHash ? { txHash: lower(fields.txHash) } : {}),
  };
}

function toOrder(row: OnrampRow): OnrampOrder {
  return {
    id: row.id,
    userId: row.userId,
    provider: row.provider,
    walletAddress: row.walletAddress as Address,
    fiat: { currency: row.fiatCurrency as FiatCurrency, minor: row.fiatAmount },
    status: row.status,
    ...(row.providerTxId === null ? {} : { providerTxId: row.providerTxId }),
    ...(row.providerStatus === null ? {} : { providerStatus: row.providerStatus }),
    ...(row.expectedTokenAmount === null ? {} : { expectedTokenAmount: row.expectedTokenAmount }),
    ...(row.txHash === null ? {} : { txHash: row.txHash as Hex }),
    ...(row.logIndex === null ? {} : { logIndex: row.logIndex }),
    ...(row.receivedAmount === null ? {} : { receivedAmount: row.receivedAmount }),
    ...(row.failureReason === null ? {} : { failureReason: row.failureReason }),
    ...(row.lastError === null ? {} : { lastError: row.lastError }),
    ...(row.lastCheckedAt === null ? {} : { lastCheckedAt: row.lastCheckedAt }),
    expiresAt: row.expiresAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function toDeposit(row: DepositRow): Deposit {
  return {
    id: row.id,
    userId: row.userId,
    chainId: row.chainId,
    token: row.token as Address,
    txHash: row.txHash as Hex,
    logIndex: row.logIndex,
    from: row.fromAddress as Address,
    amount: row.amount,
    blockNumber: row.blockNumber,
    createdAt: row.createdAt,
  };
}
