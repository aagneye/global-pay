import type { Address, Hex } from 'viem';
import { type Device, type P2pStatus, type PaymentRequest, assertP2pTransition } from '../../domain/p2p.js';
import {
  type Device as DeviceRow,
  type PaymentRequest as RequestRow,
  Prisma,
  type PrismaClient,
} from '../../generated/prisma/client.js';
import type { DeviceRepository, P2pFields, PaymentRequestRepository } from '../../ports/repositories.js';
import { AppError } from '../../shared/errors.js';

const lower = <T extends string>(value: T) => value.toLowerCase() as T;

export function deviceTaken(): AppError {
  return new AppError('device_taken', 'This device key is registered to another account', 409);
}

export class PrismaDeviceRepository implements DeviceRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async register(device: { userId: string; publicKey: string; platform: string; fcmToken?: string }): Promise<Device> {
    const existing = await this.prisma.device.findUnique({ where: { publicKey: device.publicKey } });
    if (existing && existing.userId !== device.userId) throw deviceTaken();
    // A push token belongs to one app install: take it away from any other device that had it.
    if (device.fcmToken) {
      await this.prisma.device.updateMany({ where: { fcmToken: device.fcmToken, publicKey: { not: device.publicKey } }, data: { fcmToken: null } });
    }
    try {
      const row = await this.prisma.device.upsert({
        where: { publicKey: device.publicKey },
        create: { userId: device.userId, publicKey: device.publicKey, platform: device.platform, fcmToken: device.fcmToken ?? null },
        update: { platform: device.platform, fcmToken: device.fcmToken ?? null, revokedAt: null },
      });
      return toDevice(row);
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') throw deviceTaken();
      throw error;
    }
  }

  async findById(id: string): Promise<Device | null> {
    const row = await this.prisma.device.findUnique({ where: { id } });
    return row && toDevice(row);
  }

  async listActive(userId: string): Promise<Device[]> {
    const rows = await this.prisma.device.findMany({ where: { userId, revokedAt: null }, orderBy: { createdAt: 'asc' } });
    return rows.map(toDevice);
  }

  async forgetPushToken(fcmToken: string): Promise<void> {
    await this.prisma.device.updateMany({ where: { fcmToken }, data: { fcmToken: null } });
  }

  async revoke(id: string, userId: string, now: Date): Promise<boolean> {
    const { count } = await this.prisma.device.updateMany({ where: { id, userId, revokedAt: null }, data: { revokedAt: now, fcmToken: null } });
    return count === 1;
  }
}

export class PrismaPaymentRequestRepository implements PaymentRequestRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async create(
    request: Pick<
      PaymentRequest,
      'receiverId' | 'receiverAddress' | 'recipientName' | 'nameVerified' | 'token' | 'amount' | 'nonce' | 'challenge' | 'validBefore' | 'expiresAt'
    >,
  ): Promise<PaymentRequest> {
    const row = await this.prisma.paymentRequest.create({
      data: {
        ...request,
        receiverAddress: lower(request.receiverAddress),
        token: lower(request.token),
        nonce: lower(request.nonce),
        challenge: lower(request.challenge),
      },
    });
    return toRequest(row);
  }

  async findById(id: string): Promise<PaymentRequest | null> {
    const row = await this.prisma.paymentRequest.findUnique({ where: { id } });
    return row && toRequest(row);
  }

  async identifySender(id: string, sender: { senderId: string; senderAddress: string; senderDeviceId?: string }, now: Date): Promise<boolean> {
    const { count } = await this.prisma.paymentRequest.updateMany({
      where: { id, status: 'CREATED', challengeUsedAt: null, expiresAt: { gt: now } },
      data: {
        status: 'SENDER_IDENTIFIED',
        challengeUsedAt: now,
        senderId: sender.senderId,
        senderAddress: lower(sender.senderAddress),
        senderDeviceId: sender.senderDeviceId ?? null,
      },
    });
    return count === 1;
  }

  async transition(id: string, from: P2pStatus, to: P2pStatus, fields: P2pFields = {}): Promise<boolean> {
    assertP2pTransition(from, to);
    const { count } = await this.prisma.paymentRequest.updateMany({
      where: { id, status: from },
      data: { status: to, ...fields, ...(fields.txHash ? { txHash: lower(fields.txHash) } : {}) },
    });
    return count === 1;
  }

  async countOpenByReceiver(receiverId: string): Promise<number> {
    return this.prisma.paymentRequest.count({ where: { receiverId, status: { in: ['CREATED', 'SENDER_IDENTIFIED'] } } });
  }

  async listAwaitingSender(senderId: string, now: Date): Promise<PaymentRequest[]> {
    const rows = await this.prisma.paymentRequest.findMany({
      where: { senderId, status: 'SENDER_IDENTIFIED', expiresAt: { gt: now } },
      orderBy: { createdAt: 'desc' },
    });
    return rows.map(toRequest);
  }

  async listByUser(userId: string, limit: number): Promise<PaymentRequest[]> {
    const rows = await this.prisma.paymentRequest.findMany({
      where: { OR: [{ receiverId: userId }, { senderId: userId }] },
      orderBy: { createdAt: 'desc' },
      take: limit,
    });
    return rows.map(toRequest);
  }

  async listByStatus(statuses: readonly P2pStatus[], limit: number): Promise<PaymentRequest[]> {
    const rows = await this.prisma.paymentRequest.findMany({ where: { status: { in: [...statuses] } }, orderBy: { createdAt: 'asc' }, take: limit });
    return rows.map(toRequest);
  }
}

function toDevice(row: DeviceRow): Device {
  return {
    id: row.id,
    userId: row.userId,
    publicKey: row.publicKey,
    platform: row.platform,
    ...(row.fcmToken === null ? {} : { fcmToken: row.fcmToken }),
    createdAt: row.createdAt,
    ...(row.revokedAt === null ? {} : { revokedAt: row.revokedAt }),
  };
}

function toRequest(row: RequestRow): PaymentRequest {
  return {
    id: row.id,
    receiverId: row.receiverId,
    receiverAddress: row.receiverAddress as Address,
    recipientName: row.recipientName,
    nameVerified: row.nameVerified,
    token: row.token as Address,
    amount: row.amount,
    nonce: row.nonce as Hex,
    challenge: row.challenge as Hex,
    ...(row.challengeUsedAt === null ? {} : { challengeUsedAt: row.challengeUsedAt }),
    ...(row.senderId === null ? {} : { senderId: row.senderId }),
    ...(row.senderAddress === null ? {} : { senderAddress: row.senderAddress as Address }),
    ...(row.senderDeviceId === null ? {} : { senderDeviceId: row.senderDeviceId }),
    validBefore: row.validBefore,
    expiresAt: row.expiresAt,
    status: row.status,
    ...(row.txHash === null ? {} : { txHash: row.txHash as Hex }),
    ...(row.failureReason === null ? {} : { failureReason: row.failureReason }),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}
