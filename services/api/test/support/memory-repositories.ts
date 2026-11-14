import { type Address, type Hex, keccak256, toHex } from 'viem';
import {
  PAYOUT_STATUSES,
  type Payment,
  type Payout,
  type PayoutEvent,
  type PayoutStatus,
  assertPayoutTransition,
  assertTransition,
} from '../../src/domain/payment.js';
import { type Deposit, type OnrampOrder, assertOnrampTransition } from '../../src/domain/onramp.js';
import type { KycRecord, User } from '../../src/domain/user.js';
import { alreadyCounted } from '../../src/adapters/db/prisma-onramp-repositories.js';
import { deviceTaken } from '../../src/adapters/db/prisma-p2p-repositories.js';
import { type Device, type PaymentRequest, assertP2pTransition } from '../../src/domain/p2p.js';
import { buildPromptPayQr } from '../../src/lib/promptpay/build.js';
import { parsePromptPayQr } from '../../src/lib/promptpay/parse.js';
import type {
  OnrampFields,
  OpsAction,
  PageCursor,
  PaymentFields,
  PaymentWithQuote,
  PayoutFields,
  Repositories,
  StoredQuote,
} from '../../src/ports/repositories.js';

/** In-memory repositories with the same behaviour as the Prisma ones, for fast unit tests. */
export function createMemoryRepositories() {
  const users = new Map<string, User>();
  const nonces = new Map<string, { address: string; expiresAt: Date; usedAt?: Date }>();
  const kyc = new Map<string, KycRecord>();
  const quotes = new Map<string, StoredQuote>();
  const payments = new Map<string, Payment>();
  const payouts = new Map<string, Payout>();
  const cursors = new Map<string, bigint>();
  const payoutEvents: PayoutEvent[] = [];
  const opsActions: OpsAction[] = [];
  const onrampOrders = new Map<string, OnrampOrder>();
  const deposits: Deposit[] = [];
  let nextOrderId = 1;
  const devices = new Map<string, Device>();
  const paymentRequests = new Map<string, PaymentRequest>();
  let nextDeviceId = 1;
  let nextRequestId = 1;
  let nextUserId = 1;
  let nextPaymentId = 1;
  let clock = 0;

  /** Strictly increasing timestamps, so "newest first" is deterministic. */
  const now = () => new Date(Math.max(Date.now(), ++clock));

  const withQuote = (payment: Payment): PaymentWithQuote => {
    const quote = quotes.get(payment.quoteId.toLowerCase());
    if (!quote) throw new Error(`payment ${payment.id} has no quote`);
    const payout = payouts.get(payment.id);
    return { payment: { ...payment }, quote, ...(payout ? { payout: { ...payout } } : {}) };
  };

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
      async listWallets() {
        return [...users.values()];
      },
      async updateProfile(id, profile) {
        const user = users.get(id);
        if (!user) throw new Error(`no user ${id}`);
        user.displayName = profile.displayName;
        user.nameVerified = false;
        return { ...user };
      },
    },
    nonces: {
      async create({ nonce, address, expiresAt }) {
        if (nonces.has(nonce)) throw new Error('duplicate nonce');
        nonces.set(nonce, { address: address.toLowerCase(), expiresAt });
      },
      async consume(nonce, address, at) {
        const stored = nonces.get(nonce);
        if (!stored || stored.usedAt || stored.address !== address.toLowerCase() || stored.expiresAt <= at) {
          return false;
        }
        stored.usedAt = at;
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
        quotes.set(id, { userId, ...signed });
      },
      async findById(quoteId) {
        return quotes.get(quoteId.toLowerCase()) ?? null;
      },
    },
    payments: {
      async sumFiatSince(userId, since) {
        return [...payments.values()]
          .filter((p) => p.userId === userId && p.createdAt >= since)
          .filter((p) => p.status !== 'FAILED' && p.status !== 'REFUNDED')
          .reduce((sum, p) => sum + (quotes.get(p.quoteId.toLowerCase())?.quote.fiat.minor ?? 0n), 0n);
      },
      async createForQuote(quoteId, userId) {
        const existing = [...payments.values()].find((p) => p.quoteId === quoteId.toLowerCase());
        if (existing) return { payment: { ...existing }, created: false };
        const at = now();
        const payment: Payment = {
          id: `payment_${nextPaymentId++}`,
          quoteId: quoteId.toLowerCase() as Hex,
          userId,
          status: 'SUBMITTED',
          createdAt: at,
          updatedAt: at,
        };
        payments.set(payment.id, payment);
        return { payment: { ...payment }, created: true };
      },
      async findById(id) {
        const payment = payments.get(id);
        return payment ? withQuote(payment) : null;
      },
      async findByQuoteId(quoteId) {
        const payment = [...payments.values()].find((p) => p.quoteId === quoteId.toLowerCase());
        return payment ? { ...payment } : null;
      },
      async listByUser(userId, limit) {
        return [...payments.values()]
          .filter((p) => p.userId === userId)
          .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
          .slice(0, limit)
          .map(withQuote);
      },
      async listByStatus(statuses, limit) {
        return [...payments.values()]
          .filter((p) => statuses.includes(p.status))
          .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
          .slice(0, limit)
          .map(withQuote);
      },
      async listPayoutDue(at, limit, after) {
        const due = (payout: Payout | undefined) =>
          !payout ||
          payout.status === 'SUCCEEDED' ||
          payout.status === 'FAILED' ||
          ((payout.status === 'PENDING' || payout.status === 'UNKNOWN') && (!payout.nextCheckAt || payout.nextCheckAt <= at));
        return [...payments.values()]
          .filter((p) => p.status === 'PAYOUT_PENDING' && due(payouts.get(p.id)) && isAfter(p, after))
          .sort(byCreation)
          .slice(0, limit)
          .map(withQuote);
      },
      async listAwaitingResolution(before, limit) {
        const decided = (payout: Payout | undefined) => payout?.status === 'SUCCEEDED' || payout?.status === 'FAILED';
        return [...payments.values()]
          .filter((p) => p.status === 'PAYOUT_PENDING' && p.updatedAt <= before && decided(payouts.get(p.id)))
          .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
          .slice(0, limit)
          .map(withQuote);
      },
      async listEventMismatches(limit) {
        return [...payments.values()]
          .filter((p) => p.eventMismatch !== undefined)
          .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
          .slice(0, limit)
          .map(withQuote);
      },
      async update(id, fields) {
        const payment = payments.get(id);
        if (!payment) throw new Error(`no payment ${id}`);
        applyFields(payment, lowerFields(fields));
        payment.updatedAt = now();
      },
      async transition(id, from, to, fields = {}) {
        assertTransition(from, to);
        const payment = payments.get(id);
        if (!payment || payment.status !== from) return false;
        applyFields(payment, lowerFields(fields));
        Object.assign(payment, { status: to, updatedAt: now() });
        return true;
      },
    },
    payouts: {
      async findByPaymentId(paymentId) {
        const payout = payouts.get(paymentId);
        return payout ? { ...payout } : null;
      },
      async findByIdempotencyKey(idempotencyKey) {
        const payout = [...payouts.values()].find((p) => p.idempotencyKey === idempotencyKey);
        return payout ? { ...payout } : null;
      },
      async createForPayment({ paymentId, provider, amount, idempotencyKey }) {
        let payout = payouts.get(paymentId);
        if (!payout) {
          const at = now();
          payout = {
            paymentId,
            provider,
            idempotencyKey,
            status: 'PENDING',
            amount,
            attempts: 0,
            createdAt: at,
            updatedAt: at,
          };
          payouts.set(paymentId, payout);
        }
        return { ...payout };
      },
      async update(paymentId, fields) {
        const payout = payouts.get(paymentId);
        if (!payout) throw new Error(`no payout for ${paymentId}`);
        applyPayoutFields(payout, fields);
        payout.updatedAt = now();
        return { ...payout };
      },
      async transition(paymentId, from, to, fields = {}) {
        assertPayoutTransition(from, to);
        const payout = payouts.get(paymentId);
        if (!payout || payout.status !== from) return false;
        applyPayoutFields(payout, fields);
        payout.status = to;
        payout.updatedAt = now();
        return true;
      },
      async listByStatus(statuses, limit) {
        return [...payouts.values()]
          .filter((p) => statuses.includes(p.status))
          .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
          .slice(0, limit)
          .map((p) => ({ ...p }));
      },
      async listNeedingAttention(limit) {
        return [...payouts.values()]
          .filter((p) => p.status === 'UNKNOWN' || p.status === 'REVERSED' || p.lastError !== undefined)
          .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
          .slice(0, limit)
          .map((p) => ({ ...p }));
      },
      async countByStatus() {
        const counts = Object.fromEntries(PAYOUT_STATUSES.map((status) => [status, 0])) as Record<PayoutStatus, number>;
        for (const payout of payouts.values()) counts[payout.status]++;
        return counts;
      },
      async recordEvent(paymentId, event) {
        if (!payouts.has(paymentId)) throw new Error(`no payout for ${paymentId}`);
        payoutEvents.push({ ...event, paymentId, createdAt: now() });
      },
      async listEvents(paymentId, limit) {
        return payoutEvents
          .filter((e) => e.paymentId === paymentId)
          .reverse()
          .slice(0, limit);
      },
    },
    opsActions: {
      async record(action) {
        const recorded: OpsAction = { ...action, id: `ops_${opsActions.length + 1}`, createdAt: now() };
        opsActions.push(recorded);
        return recorded;
      },
      async list(limit, target) {
        return opsActions
          .filter((a) => !target || (a.targetType === target.type && a.targetId === target.id))
          .reverse()
          .slice(0, limit);
      },
    },
    onrampOrders: {
      async create(order) {
        const at = now();
        const created: OnrampOrder = {
          ...order,
          walletAddress: order.walletAddress.toLowerCase() as Address,
          id: `order_${nextOrderId++}`,
          status: 'CREATED',
          createdAt: at,
          updatedAt: at,
        };
        onrampOrders.set(created.id, created);
        return { ...created };
      },
      async findById(id) {
        const order = onrampOrders.get(id);
        return order ? { ...order } : null;
      },
      async listByUser(userId, limit) {
        return [...onrampOrders.values()]
          .filter((o) => o.userId === userId)
          .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
          .slice(0, limit)
          .map((o) => ({ ...o }));
      },
      async listByStatus(statuses, limit) {
        return [...onrampOrders.values()]
          .filter((o) => statuses.includes(o.status))
          .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
          .slice(0, limit)
          .map((o) => ({ ...o }));
      },
      async listDue({ statuses, checkedBefore, createdAfter, after }, limit) {
        const due = (o: OnrampOrder) => !o.lastCheckedAt || o.lastCheckedAt <= checkedBefore || (o.status === 'PENDING' && o.txHash !== undefined);
        return [...onrampOrders.values()]
          .filter((o) => statuses.includes(o.status) && due(o) && (!createdAfter || o.createdAt > createdAfter) && isAfter(o, after))
          .sort(byCreation)
          .slice(0, limit)
          .map((o) => ({ ...o }));
      },
      async countOpen(userId) {
        return [...onrampOrders.values()].filter((o) => o.userId === userId && (o.status === 'CREATED' || o.status === 'PENDING')).length;
      },
      async update(id, fields) {
        const order = onrampOrders.get(id);
        if (!order) throw new Error(`no order ${id}`);
        applyFields(order, lowerOnramp(fields));
        order.updatedAt = now();
        return { ...order };
      },
      async transition(id, from, to, fields = {}) {
        assertOnrampTransition(from, to);
        const order = onrampOrders.get(id);
        if (!order || order.status !== from) return false;
        const next = lowerOnramp(fields);
        const txHash = next.txHash ?? order.txHash;
        const logIndex = next.logIndex ?? order.logIndex;
        if (txHash && logIndex !== undefined && logIndex !== null) {
          const taken = [...onrampOrders.values()].some((o) => o.id !== id && o.txHash === txHash && o.logIndex === logIndex);
          if (taken) throw alreadyCounted();
        }
        applyFields(order, next);
        order.status = to;
        order.updatedAt = now();
        return true;
      },
    },
    deposits: {
      async record(deposit) {
        const lowered = {
          ...deposit,
          token: deposit.token.toLowerCase() as Address,
          txHash: deposit.txHash.toLowerCase() as Hex,
          from: deposit.from.toLowerCase() as Address,
        };
        const exists = deposits.some((d) => d.chainId === lowered.chainId && d.txHash === lowered.txHash && d.logIndex === lowered.logIndex);
        if (exists) return false;
        deposits.push({ ...lowered, id: `deposit_${deposits.length + 1}`, createdAt: now() });
        return true;
      },
      async listByUser(userId, limit) {
        return deposits
          .filter((d) => d.userId === userId)
          .sort((a, b) => (a.blockNumber === b.blockNumber ? b.logIndex - a.logIndex : Number(b.blockNumber - a.blockNumber)))
          .slice(0, limit)
          .map((d) => ({ ...d }));
      },
    },
    devices: {
      async register(device) {
        const existing = [...devices.values()].find((d) => d.publicKey === device.publicKey);
        if (existing && existing.userId !== device.userId) throw deviceTaken();
        if (device.fcmToken) {
          for (const d of devices.values()) if (d.fcmToken === device.fcmToken && d.publicKey !== device.publicKey) delete d.fcmToken;
        }
        if (existing) {
          existing.platform = device.platform;
          if (device.fcmToken) existing.fcmToken = device.fcmToken;
          else delete existing.fcmToken;
          delete existing.revokedAt;
          return { ...existing };
        }
        const created: Device = {
          id: `device_${nextDeviceId++}`,
          userId: device.userId,
          publicKey: device.publicKey,
          platform: device.platform,
          ...(device.fcmToken ? { fcmToken: device.fcmToken } : {}),
          createdAt: now(),
        };
        devices.set(created.id, created);
        return { ...created };
      },
      async findById(id) {
        const device = devices.get(id);
        return device ? { ...device } : null;
      },
      async listActive(userId) {
        return [...devices.values()].filter((d) => d.userId === userId && !d.revokedAt).map((d) => ({ ...d }));
      },
      async forgetPushToken(fcmToken) {
        for (const d of devices.values()) if (d.fcmToken === fcmToken) delete d.fcmToken;
      },
      async revoke(id, userId, at) {
        const device = devices.get(id);
        if (!device || device.userId !== userId || device.revokedAt) return false;
        device.revokedAt = at;
        delete device.fcmToken;
        return true;
      },
    },
    paymentRequests: {
      async create(request) {
        const at = now();
        const created: PaymentRequest = {
          ...request,
          receiverAddress: request.receiverAddress.toLowerCase() as Address,
          token: request.token.toLowerCase() as Address,
          nonce: request.nonce.toLowerCase() as Hex,
          challenge: request.challenge.toLowerCase() as Hex,
          id: `request_${nextRequestId++}`,
          status: 'CREATED',
          createdAt: at,
          updatedAt: at,
        };
        paymentRequests.set(created.id, created);
        return { ...created };
      },
      async findById(id) {
        const request = paymentRequests.get(id);
        return request ? { ...request } : null;
      },
      async identifySender(id, sender, at) {
        const request = paymentRequests.get(id);
        if (!request || request.status !== 'CREATED' || request.challengeUsedAt || request.expiresAt <= at) return false;
        Object.assign(request, {
          status: 'SENDER_IDENTIFIED',
          challengeUsedAt: at,
          senderId: sender.senderId,
          senderAddress: sender.senderAddress.toLowerCase(),
          ...(sender.senderDeviceId ? { senderDeviceId: sender.senderDeviceId } : {}),
          updatedAt: now(),
        });
        return true;
      },
      async transition(id, from, to, fields = {}) {
        assertP2pTransition(from, to);
        const request = paymentRequests.get(id);
        if (!request || request.status !== from) return false;
        applyFields(request, { ...fields, ...(fields.txHash ? { txHash: fields.txHash.toLowerCase() } : {}) });
        request.status = to;
        request.updatedAt = now();
        return true;
      },
      async transitionIfUnsent(id, from, to) {
        assertP2pTransition(from, to);
        const request = paymentRequests.get(id);
        if (!request || request.status !== from || request.txHash) return false;
        request.status = to;
        request.updatedAt = now();
        return true;
      },
      async recordTxHash(id, status, txHash) {
        const request = paymentRequests.get(id);
        if (!request || request.status !== status) return false;
        request.txHash = txHash.toLowerCase() as Hex;
        request.updatedAt = now();
        return true;
      },
      async countOpenByReceiver(receiverId) {
        return [...paymentRequests.values()].filter((r) => r.receiverId === receiverId && (r.status === 'CREATED' || r.status === 'SENDER_IDENTIFIED')).length;
      },
      async sumSentSince(senderId, since) {
        return [...paymentRequests.values()]
          .filter((r) => r.senderId === senderId && ['APPROVING', 'SUBMITTED', 'COMPLETED'].includes(r.status) && r.createdAt >= since)
          .reduce((sum, r) => sum + r.amount, 0n);
      },
      async listAwaitingSender(senderId, at) {
        return [...paymentRequests.values()]
          .filter((r) => r.senderId === senderId && r.status === 'SENDER_IDENTIFIED' && r.expiresAt > at)
          .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
          .map((r) => ({ ...r }));
      },
      async listByUser(userId, limit) {
        return [...paymentRequests.values()]
          .filter((r) => r.receiverId === userId || r.senderId === userId)
          .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
          .slice(0, limit)
          .map((r) => ({ ...r }));
      },
      async listByStatus(statuses, limit) {
        return [...paymentRequests.values()]
          .filter((r) => statuses.includes(r.status))
          .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
          .slice(0, limit)
          .map((r) => ({ ...r }));
      },
    },
    cursors: {
      async get(id) {
        return cursors.get(id) ?? null;
      },
      async set(id, lastBlock) {
        cursors.set(id, lastBlock);
      },
    },
  };

  return {
    ...repositories,
    /** Test-only views of the stored data. */
    state: { users, nonces, kyc, quotes, payments, payouts, cursors, payoutEvents, opsActions, onrampOrders, deposits, devices, paymentRequests },
  };
}

/** Like the Prisma repositories' `afterCursor`: after `after` in (createdAt, id) order. */
function isAfter(item: PageCursor, after: PageCursor | undefined): boolean {
  if (!after) return true;
  const diff = item.createdAt.getTime() - after.createdAt.getTime();
  return diff > 0 || (diff === 0 && item.id > after.id);
}

/** Sorts like `ORDER BY createdAt, id`. */
function byCreation(a: PageCursor, b: PageCursor): number {
  return a.createdAt.getTime() - b.createdAt.getTime() || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

/** Applies fields like the database would: `null` clears, `undefined` leaves alone. */
function applyFields(target: object, fields: object): void {
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined) continue;
    if (value === null) delete (target as Record<string, unknown>)[key];
    else (target as Record<string, unknown>)[key] = value;
  }
}

function applyPayoutFields(payout: Payout, fields: PayoutFields): void {
  applyFields(payout, fields);
}

function lowerOnramp(fields: OnrampFields): OnrampFields {
  return { ...fields, ...(fields.txHash ? { txHash: fields.txHash.toLowerCase() as Hex } : {}) };
}

function lowerFields(fields: PaymentFields): PaymentFields {
  return {
    ...fields,
    ...(fields.payTxHash ? { payTxHash: fields.payTxHash.toLowerCase() as Hex } : {}),
    ...(fields.settleTxHash ? { settleTxHash: fields.settleTxHash.toLowerCase() as Hex } : {}),
    ...(fields.refundTxHash ? { refundTxHash: fields.refundTxHash.toLowerCase() as Hex } : {}),
  };
}

export type MemoryRepositories = ReturnType<typeof createMemoryRepositories>;

let seeded = 0;

/** Stores a payment (and a quote for it) directly, for tests that need history. */
export function seedPayment(
  repos: MemoryRepositories,
  input: { userId: string; fiatMinor: bigint; status: Payment['status']; createdAt: Date },
): Payment {
  const quoteId = keccak256(toHex(`seeded-${++seeded}`));
  const merchant = parsePromptPayQr(
    buildPromptPayQr({
      kind: 'merchant',
      targetType: 'biller',
      targetId: '099999999999901',
      amount: { currency: 'THB', minor: input.fiatMinor },
    }),
  );
  repos.state.quotes.set(quoteId, {
    userId: input.userId,
    signature: '0x',
    quote: {
      quoteId,
      payer: '0x0000000000000000000000000000000000000001',
      token: '0x0000000000000000000000000000000000000002',
      tokenAmount: input.fiatMinor * 10_000n,
      fiat: { currency: 'THB', minor: input.fiatMinor },
      rateE8: 32_50000000n,
      spreadBps: 100,
      merchantRef: 'promptpay:biller:099999999999901',
      merchantRefHash: keccak256(toHex('promptpay:biller:099999999999901')),
      merchant,
      expiresAt: input.createdAt,
    },
  });
  const payment: Payment = {
    id: `seeded_${seeded}`,
    quoteId,
    userId: input.userId,
    status: input.status,
    createdAt: input.createdAt,
    updatedAt: input.createdAt,
  };
  repos.state.payments.set(payment.id, payment);
  return payment;
}
