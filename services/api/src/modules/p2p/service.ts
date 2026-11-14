import { randomBytes, timingSafeEqual } from 'node:crypto';
import { type Address, type Hex, bytesToHex, getAddress, isHex, verifyTypedData } from 'viem';
import { TOKEN_DECIMALS } from '../../domain/money.js';
import type { PaymentRequest } from '../../domain/p2p.js';
import { effectiveTier } from '../../domain/user.js';
import { isP256PublicKey, verifyTapSignature } from '../../lib/p256.js';
import { TRANSFER_WITH_AUTHORIZATION_TYPES } from '../../lib/typed-data.js';
import type { PushMessage, PushSender } from '../../ports/push-sender.js';
import type { DeviceRepository, KycRepository, PaymentRequestRepository, UserRepository } from '../../ports/repositories.js';
import { ChainUnavailableError, type SettlementGateway } from '../../ports/settlement-gateway.js';
import { AppError } from '../../shared/errors.js';

export interface P2pServiceDeps {
  users: UserRepository;
  kyc: KycRepository;
  devices: DeviceRepository;
  requests: PaymentRequestRepository;
  gateway: Pick<SettlementGateway, 'submitTransfer' | 'getTokenDomain'>;
  push: PushSender;
  chainId: number;
  usdcAddress: Address;
  /** The sender must approve within this (2 minutes). */
  requestTtlMs: number;
  /** EIP-3009 validBefore, from the request's creation. */
  authorizationTtlMs: number;
  maxAmount: bigint;
  maxOpenPerReceiver: number;
  maxAwaitingPerSender: number;
  explorerUrl: string;
  now?: () => Date;
  random32?: () => Hex;
  log?: { warn(obj: object, message: string): void };
}

/** A request as one party sees it. Amounts are integer strings in token base units. */
export interface P2pRequestView {
  id: string;
  role: 'receiver' | 'sender';
  status: PaymentRequest['status'];
  token: Address;
  amount: string;
  recipient: { name: string; verified: boolean; address: Address };
  /** The sender's wallet, once identified. */
  sender?: { address: Address };
  /** Receiver only, while the request waits for a sender: what the other phone signs, and what the QR carries. */
  challenge?: Hex;
  transaction?: { hash: Hex; url: string };
  failureReason?: string;
  expiresAt: string;
  createdAt: string;
  updatedAt: string;
}

const NAME = /^[\p{L}\p{M}\p{N} .,'&()-]{2,40}$/u;

/**
 * Tap to pay (ADR 0010): the receiver asks for an amount; the sender is identified by a tap (their phone
 * signs the request's one-time challenge with its hardware key) or by scanning the receiver's QR; the
 * sender approves on their own phone and signs a USDC TransferWithAuthorization, which we relay.
 *
 * The backend decides who may see and do what: the receiver sees the challenge; only the identified sender
 * can fetch the authorization, approve or decline; every field of the signed transfer is checked against
 * the stored request.
 */
export class P2pService {
  private readonly deps: P2pServiceDeps;
  private readonly now: () => Date;
  private readonly random32: () => Hex;
  private readonly approving = new Set<string>();

  constructor(deps: P2pServiceDeps) {
    this.deps = deps;
    this.now = deps.now ?? (() => new Date());
    this.random32 = deps.random32 ?? (() => bytesToHex(randomBytes(32)));
  }

  /** The name others see when paying you. Your own word, so never shown as verified. */
  async updateProfile(userId: string, displayName: string): Promise<{ displayName: string; nameVerified: boolean }> {
    const name = displayName.trim().replace(/\s+/g, ' ');
    if (!NAME.test(name)) {
      throw new AppError('invalid_name', 'Use 2 to 40 letters, numbers, spaces or . , \' & ( ) -', 422);
    }
    const user = await this.deps.users.updateProfile(userId, { displayName: name });
    return { displayName: user.displayName ?? name, nameVerified: user.nameVerified ?? false };
  }

  async registerDevice(userId: string, device: { publicKey: string; platform: string; fcmToken?: string }): Promise<{ id: string }> {
    if (!isP256PublicKey(device.publicKey)) {
      throw new AppError('invalid_device_key', 'publicKey must be a P-256 public key (SPKI DER, base64)', 422);
    }
    const registered = await this.deps.devices.register({ userId, ...device });
    return { id: registered.id };
  }

  async revokeDevice(userId: string, deviceId: string): Promise<void> {
    if (!(await this.deps.devices.revoke(deviceId, userId, this.now()))) throw new AppError('not_found', 'No such device', 404);
  }

  /** The receiver asks for `amount` (USDC base units). */
  async createRequest(receiverId: string, amount: bigint): Promise<P2pRequestView> {
    const { users, requests, maxAmount } = this.deps;
    const receiver = await users.findById(receiverId);
    if (!receiver) throw new AppError('unauthorized', 'Unknown user; sign in again', 401);
    await this.requireVerified(receiverId);
    if (amount <= 0n) throw new AppError('invalid_amount', 'The amount must be positive', 422);
    if (amount > maxAmount) throw new AppError('amount_too_large', `The most you can request is ${usdc(maxAmount)} USDC`, 422);
    if ((await requests.countOpenByReceiver(receiverId)) >= this.deps.maxOpenPerReceiver) {
      throw new AppError('too_many_requests', 'Finish or cancel your open requests first', 429);
    }

    const now = this.now();
    const request = await requests.create({
      receiverId,
      receiverAddress: receiver.walletAddress,
      recipientName: receiver.displayName ?? `Wallet ${receiver.walletAddress.slice(0, 6)}…${receiver.walletAddress.slice(-4)}`,
      nameVerified: receiver.nameVerified ?? false,
      token: this.deps.usdcAddress,
      amount,
      nonce: this.random32(),
      challenge: this.random32(),
      validBefore: BigInt(Math.floor((now.getTime() + this.deps.authorizationTtlMs) / 1000)),
      expiresAt: new Date(now.getTime() + this.deps.requestTtlMs),
    });
    return this.view(request, receiverId);
  }

  /**
   * The receiver's phone read the sender's phone over NFC: the device ID it announced and its signature
   * over this request's challenge. On success the sender is told (push) to review and approve.
   */
  async tap(receiverId: string, requestId: string, tap: { deviceId: string; signature: Hex }): Promise<P2pRequestView> {
    const request = await this.receiverRequest(receiverId, requestId);
    const device = await this.deps.devices.findById(tap.deviceId);
    if (!device || device.revokedAt || !isHex(tap.signature) || !verifyTapSignature(device.publicKey, request.challenge, tap.signature)) {
      throw new AppError('invalid_tap', "The other phone's answer didn't check out; try again", 422);
    }
    const sender = await this.identify(request, device.userId, device.id);
    await this.notify(sender.id, { title: 'Payment request', body: 'Open GlobalPay to review it', data: { type: 'p2p_request', requestId } });
    return this.view((await this.deps.requests.findById(requestId)) ?? request, receiverId);
  }

  /** The QR fallback: the sender scanned the receiver's code, which carries the request ID and challenge. */
  async claim(senderId: string, requestId: string, challenge: string): Promise<P2pRequestView> {
    const request = await this.deps.requests.findById(requestId);
    const given = Buffer.from(challenge.toLowerCase());
    if (!request || given.length !== request.challenge.length || !timingSafeEqual(given, Buffer.from(request.challenge))) {
      throw new AppError('not_found', 'No such request', 404);
    }
    await this.identify(request, senderId);
    return this.view((await this.deps.requests.findById(requestId)) ?? request, senderId);
  }

  async get(userId: string, requestId: string): Promise<P2pRequestView> {
    const request = await this.deps.requests.findById(requestId);
    if (!request || (request.receiverId !== userId && request.senderId !== userId)) throw new AppError('not_found', 'No such request', 404);
    return this.view(request, userId);
  }

  /** Requests waiting for this user's approval (the sender's app polls this when push is off). */
  async incoming(senderId: string): Promise<P2pRequestView[]> {
    return (await this.deps.requests.listAwaitingSender(senderId, this.now())).map((r) => this.view(r, senderId));
  }

  async list(userId: string): Promise<P2pRequestView[]> {
    return (await this.deps.requests.listByUser(userId, 50)).map((r) => this.view(r, userId));
  }

  /** The EIP-712 TransferWithAuthorization the sender's wallet signs, built only from the stored request. */
  async authorization(senderId: string, requestId: string) {
    const request = await this.awaitingSender(senderId, requestId);
    return this.typedData(request);
  }

  /** The sender approved: check the signature against the stored request, then relay the transfer. */
  async approve(senderId: string, requestId: string, signature: Hex): Promise<P2pRequestView> {
    const request = await this.awaitingSender(senderId, requestId);
    await this.requireVerified(senderId);
    const typed = await this.typedData(request);
    const valid = await verifyTypedData({ address: request.senderAddress!, signature, ...typed }).catch(() => false);
    if (!valid) throw new AppError('invalid_signature', "The signature doesn't match this request", 422);

    if (this.approving.has(requestId)) throw new AppError('request_in_progress', 'This request is already being approved', 409);
    this.approving.add(requestId);
    try {
      let txHash: Hex;
      try {
        txHash = await this.deps.gateway.submitTransfer({
          token: request.token,
          from: request.senderAddress!,
          to: request.receiverAddress,
          value: request.amount,
          validAfter: 0n,
          validBefore: request.validBefore,
          nonce: request.nonce,
          signature,
        });
      } catch (error) {
        // Signed and maybe sent: record it, and let the worker find out from the receipt.
        if (error instanceof ChainUnavailableError && error.txHash) txHash = error.txHash;
        else throw error;
      }
      await this.deps.requests.transition(requestId, 'SENDER_IDENTIFIED', 'SUBMITTED', { txHash });
    } finally {
      this.approving.delete(requestId);
    }
    return this.view((await this.deps.requests.findById(requestId)) ?? request, senderId);
  }

  async decline(senderId: string, requestId: string): Promise<P2pRequestView> {
    const request = await this.awaitingSender(senderId, requestId);
    await this.deps.requests.transition(requestId, 'SENDER_IDENTIFIED', 'DECLINED');
    return this.view((await this.deps.requests.findById(requestId)) ?? request, senderId);
  }

  async cancel(receiverId: string, requestId: string): Promise<P2pRequestView> {
    const request = await this.receiverRequest(receiverId, requestId);
    if (request.status !== 'CREATED' && request.status !== 'SENDER_IDENTIFIED') {
      throw new AppError('request_unavailable', `The request is ${request.status}`, 409);
    }
    await this.deps.requests.transition(requestId, request.status, 'CANCELLED');
    return this.view((await this.deps.requests.findById(requestId)) ?? request, receiverId);
  }

  /** Tells all of a user's phones, forgetting tokens the push service no longer knows. Never throws. */
  async notify(userId: string, message: PushMessage): Promise<void> {
    for (const device of await this.deps.devices.listActive(userId)) {
      if (!device.fcmToken) continue;
      try {
        if ((await this.deps.push.send(device.fcmToken, message)) === 'unregistered') await this.deps.devices.forgetPushToken(device.fcmToken);
      } catch (error) {
        this.deps.log?.warn({ err: error, deviceId: device.id }, 'push failed');
      }
    }
  }

  view(request: PaymentRequest, userId: string): P2pRequestView {
    const role = request.receiverId === userId ? 'receiver' : 'sender';
    const explorer = this.deps.explorerUrl.replace(/\/$/, '');
    return {
      id: request.id,
      role,
      status: request.status,
      token: getAddress(request.token),
      amount: request.amount.toString(),
      recipient: { name: request.recipientName, verified: request.nameVerified, address: getAddress(request.receiverAddress) },
      ...(request.senderAddress ? { sender: { address: getAddress(request.senderAddress) } } : {}),
      ...(role === 'receiver' && request.status === 'CREATED' ? { challenge: request.challenge } : {}),
      ...(request.txHash ? { transaction: { hash: request.txHash, url: `${explorer}/tx/${request.txHash}` } } : {}),
      ...(request.failureReason ? { failureReason: request.failureReason } : {}),
      expiresAt: request.expiresAt.toISOString(),
      createdAt: request.createdAt.toISOString(),
      updatedAt: request.updatedAt.toISOString(),
    };
  }

  /** Makes `senderId` the request's sender, using up its challenge. */
  private async identify(request: PaymentRequest, senderId: string, deviceId?: string) {
    if (senderId === request.receiverId) throw new AppError('cannot_pay_yourself', "You can't pay your own request", 422);
    const sender = await this.deps.users.findById(senderId);
    if (!sender) throw new AppError('invalid_tap', 'Unknown sender', 422);
    if ((await this.deps.requests.listAwaitingSender(senderId, this.now())).length >= this.deps.maxAwaitingPerSender) {
      throw new AppError('too_many_requests', 'The other person has too many requests waiting for them', 429);
    }
    const identified = await this.deps.requests.identifySender(
      request.id,
      { senderId, senderAddress: sender.walletAddress, ...(deviceId ? { senderDeviceId: deviceId } : {}) },
      this.now(),
    );
    if (!identified) throw new AppError('request_unavailable', 'This request has expired or was already used', 409);
    return sender;
  }

  private async receiverRequest(receiverId: string, requestId: string): Promise<PaymentRequest> {
    const request = await this.deps.requests.findById(requestId);
    if (!request || request.receiverId !== receiverId) throw new AppError('not_found', 'No such request', 404);
    return request;
  }

  /** The request, if this user is its identified sender and it's still waiting for them. */
  private async awaitingSender(senderId: string, requestId: string): Promise<PaymentRequest> {
    const request = await this.deps.requests.findById(requestId);
    if (!request || request.senderId !== senderId) throw new AppError('not_found', 'No such request', 404);
    if (request.status !== 'SENDER_IDENTIFIED') throw new AppError('request_unavailable', `The request is ${request.status}`, 409);
    if (this.now() >= request.expiresAt) throw new AppError('request_expired', 'This request has expired', 409);
    return request;
  }

  private async requireVerified(userId: string): Promise<void> {
    if (effectiveTier(await this.deps.kyc.find(userId)) < 1) {
      throw new AppError('kyc_required', 'Verify your identity first', 403);
    }
  }

  private async typedData(request: PaymentRequest) {
    const domain = await this.deps.gateway.getTokenDomain(request.token);
    return {
      domain: { ...domain, chainId: this.deps.chainId, verifyingContract: getAddress(request.token) },
      types: TRANSFER_WITH_AUTHORIZATION_TYPES,
      primaryType: 'TransferWithAuthorization' as const,
      message: {
        from: getAddress(request.senderAddress!),
        to: getAddress(request.receiverAddress),
        value: request.amount,
        validAfter: 0n,
        validBefore: request.validBefore,
        nonce: request.nonce,
      },
    };
  }
}

function usdc(units: bigint): string {
  const scale = 10n ** BigInt(TOKEN_DECIMALS.USDC);
  const fraction = (units % scale).toString().padStart(TOKEN_DECIMALS.USDC, '0').replace(/0+$/, '');
  return `${units / scale}${fraction ? `.${fraction}` : ''}`;
}
