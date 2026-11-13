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
import type { KycRecord, User } from '../../src/domain/user.js';
import { buildPromptPayQr } from '../../src/lib/promptpay/build.js';
import { parsePromptPayQr } from '../../src/lib/promptpay/parse.js';
import type {
  OpsAction,
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
  let nextUserId = 1;
  let nextPaymentId = 1;
  let clock = 0;

  /** Strictly increasing timestamps, so "newest first" is deterministic. */
  const now = () => new Date(Math.max(Date.now(), ++clock));

  const withQuote = (payment: Payment): PaymentWithQuote => {
    const quote = quotes.get(payment.quoteId.toLowerCase());
    if (!quote) throw new Error(`payment ${payment.id} has no quote`);
    return { payment: { ...payment }, quote };
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
      async update(id, fields) {
        const payment = payments.get(id);
        if (!payment) throw new Error(`no payment ${id}`);
        Object.assign(payment, lowerFields(fields), { updatedAt: now() });
      },
      async transition(id, from, to, fields = {}) {
        assertTransition(from, to);
        const payment = payments.get(id);
        if (!payment || payment.status !== from) return false;
        Object.assign(payment, lowerFields(fields), { status: to, updatedAt: now() });
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
    state: { users, nonces, kyc, quotes, payments, payouts, cursors, payoutEvents, opsActions },
  };
}

/** Applies fields like the database would: `null` clears, `undefined` leaves alone. */
function applyPayoutFields(payout: Payout, fields: PayoutFields): void {
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined) continue;
    if (value === null) delete (payout as unknown as Record<string, unknown>)[key];
    else (payout as unknown as Record<string, unknown>)[key] = value;
  }
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
