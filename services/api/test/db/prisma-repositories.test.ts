import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createPrismaClient, createPrismaRepositories } from '../../src/adapters/db/prisma-repositories.js';
import type { PrismaClient } from '../../src/generated/prisma/client.js';
import { buildPromptPayQr } from '../../src/lib/promptpay/build.js';
import { merchantRef, merchantRefHash } from '../../src/lib/promptpay/merchant-ref.js';
import { parsePromptPayQr } from '../../src/lib/promptpay/parse.js';
import type { Repositories } from '../../src/ports/repositories.js';
import { ANVIL } from '../support/anvil.js';

/**
 * Runs against a real Postgres with the migrations applied. Skipped unless TEST_DATABASE_URL is set.
 * It EMPTIES every table, so never point it at a database you care about.
 *
 *   TEST_DATABASE_URL=postgresql://… npm test
 */
const url = process.env.TEST_DATABASE_URL;
const PAYER = ANVIL.accounts.payer.address;

describe.skipIf(!url)('Prisma repositories (Postgres)', () => {
  let prisma: PrismaClient;
  let repos: Repositories;

  beforeAll(() => {
    prisma = createPrismaClient(url!);
    repos = createPrismaRepositories(prisma);
  });

  afterAll(async () => {
    await prisma?.$disconnect();
  });

  beforeEach(async () => {
    await prisma.$executeRawUnsafe(
      'TRUNCATE "PaymentRequest", "Device", "Deposit", "OnrampOrder", "OpsAction", "PayoutEvent", "Payout", "Payment", "Quote", "KycRecord", "SiweNonce", "User", "IndexerCursor" CASCADE',
    );
  });

  it('creates a user once per wallet, stored lowercase', async () => {
    const first = await repos.users.upsertByWallet(PAYER);
    const again = await repos.users.upsertByWallet(PAYER.toLowerCase() as typeof PAYER);

    expect(first.walletAddress).toBe(PAYER.toLowerCase());
    expect(again.id).toBe(first.id);
    await expect(repos.users.findById(first.id)).resolves.toEqual(first);
    await expect(repos.users.findById('missing')).resolves.toBeNull();
  });

  it('consumes a nonce once, only for its address and before it expires', async () => {
    const now = new Date('2026-11-12T00:00:00Z');
    const later = new Date(now.getTime() + 600_000);
    await repos.nonces.create({ nonce: 'abcdefgh1', address: PAYER, expiresAt: new Date(now.getTime() + 300_000) });

    await expect(repos.nonces.consume('abcdefgh1', ANVIL.accounts.treasury.address, now)).resolves.toBe(false);
    await expect(repos.nonces.consume('abcdefgh1', PAYER, later)).resolves.toBe(false);
    await expect(repos.nonces.consume('missing', PAYER, now)).resolves.toBe(false);
    await expect(repos.nonces.consume('abcdefgh1', PAYER, now)).resolves.toBe(true);
    await expect(repos.nonces.consume('abcdefgh1', PAYER, now)).resolves.toBe(false);
  });

  it('lets only one of two concurrent sign-ins use a nonce', async () => {
    const now = new Date();
    await repos.nonces.create({ nonce: 'abcdefgh2', address: PAYER, expiresAt: new Date(now.getTime() + 300_000) });
    const results = await Promise.all([
      repos.nonces.consume('abcdefgh2', PAYER, now),
      repos.nonces.consume('abcdefgh2', PAYER, now),
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);
  });

  it('creates and updates the KYC record', async () => {
    const user = await repos.users.upsertByWallet(PAYER);
    await expect(repos.kyc.find(user.id)).resolves.toBeNull();

    await repos.kyc.save({ userId: user.id, provider: 'mock', status: 'PENDING', tier: 0 });
    await expect(repos.kyc.find(user.id)).resolves.toEqual({
      userId: user.id,
      provider: 'mock',
      status: 'PENDING',
      tier: 0,
    });

    await repos.kyc.save({ userId: user.id, provider: 'mock', providerRef: 'ref-1', status: 'APPROVED', tier: 1 });
    await expect(repos.kyc.find(user.id)).resolves.toMatchObject({ status: 'APPROVED', tier: 1, providerRef: 'ref-1' });
  });

  async function storeQuote(userId: string, id: string, fiatMinor: bigint) {
    const qr = parsePromptPayQr(
      buildPromptPayQr({
        kind: 'merchant',
        targetType: 'biller',
        targetId: '099999999999901',
        amount: { currency: 'THB', minor: fiatMinor },
        merchantName: 'GLOBALPAY TEST CAFE',
      }),
    );
    const ref = merchantRef(qr);
    await repos.quotes.create(userId, {
      quote: {
        quoteId: id as `0x${string}`,
        payer: PAYER,
        token: ANVIL.usdc,
        tokenAmount: 3_107_693n,
        fiat: { currency: 'THB', minor: fiatMinor },
        rateE8: 32_50000000n,
        spreadBps: 100,
        merchantRef: ref,
        merchantRefHash: merchantRefHash(ref),
        merchant: qr,
        expiresAt: new Date('2026-11-12T00:01:00Z'),
      },
      signature: `0x${'AB'.repeat(65)}`,
    });
    return qr;
  }

  it('stores a signed quote with lowercase hex and bigint amounts', async () => {
    const user = await repos.users.upsertByWallet(PAYER);
    const id = `0x${'CD'.repeat(32)}`;
    const qr = await storeQuote(user.id, id, 100_00n);

    const row = await prisma.quote.findUniqueOrThrow({ where: { id: id.toLowerCase() } });
    expect(row).toMatchObject({
      userId: user.id,
      payer: PAYER.toLowerCase(),
      token: ANVIL.usdc.toLowerCase(),
      tokenAmount: 3_107_693n,
      fiatCurrency: 'THB',
      fiatAmount: 100_00n,
      rateE8: 32_50000000n,
      spreadBps: 100,
      merchantKind: 'merchant',
      merchantRef: 'promptpay:biller:099999999999901',
      merchantName: 'GLOBALPAY TEST CAFE',
      qrPayload: qr.raw,
      signature: `0x${'ab'.repeat(65)}`,
    });
  });

  it("sums the last 24 hours' payments, excluding failed and refunded ones", async () => {
    const user = await repos.users.upsertByWallet(PAYER);
    const now = new Date();
    const payments: [bigint, 'SETTLED' | 'PAID' | 'FAILED' | 'REFUNDED', Date][] = [
      [100_00n, 'SETTLED', now],
      [200_00n, 'PAID', now],
      [400_00n, 'FAILED', now],
      [800_00n, 'REFUNDED', now],
      [1_600_00n, 'SETTLED', new Date(now.getTime() - 25 * 3600_000)],
    ];
    for (const [index, [fiat, status, createdAt]] of payments.entries()) {
      const id = `0x${String(index).padStart(64, '0')}`;
      await storeQuote(user.id, id, fiat);
      await prisma.payment.create({ data: { quoteId: id, userId: user.id, status, createdAt } });
    }
    await storeQuote(user.id, `0x${'ee'.repeat(32)}`, 3_200_00n); // quoted but never paid

    const since = new Date(now.getTime() - 24 * 3600_000);
    await expect(repos.payments.sumFiatSince(user.id, since)).resolves.toBe(300_00n);
    await expect(repos.payments.sumFiatSince('nobody', since)).resolves.toBe(0n);
  });

  it('reads a stored quote back exactly as signed', async () => {
    const user = await repos.users.upsertByWallet(PAYER);
    const id = `0x${'ab'.repeat(32)}`;
    const qr = await storeQuote(user.id, id, 250_00n);

    const stored = await repos.quotes.findById(id as `0x${string}`);
    expect(stored).toMatchObject({
      userId: user.id,
      signature: `0x${'ab'.repeat(65)}`,
      quote: {
        quoteId: id,
        payer: PAYER,
        token: ANVIL.usdc,
        tokenAmount: 3_107_693n,
        fiat: { currency: 'THB', minor: 250_00n },
        merchantRef: 'promptpay:biller:099999999999901',
        expiresAt: new Date('2026-11-12T00:01:00Z'),
      },
    });
    expect(stored?.quote.merchant).toEqual(qr);
    await expect(repos.quotes.findById(`0x${'00'.repeat(32)}`)).resolves.toBeNull();
  });

  it('creates one payment per quote and moves it only from the expected status', async () => {
    const user = await repos.users.upsertByWallet(PAYER);
    const quoteId = `0x${'cd'.repeat(32)}` as const;
    await storeQuote(user.id, quoteId, 100_00n);

    const first = await repos.payments.createForQuote(quoteId, user.id);
    const second = await repos.payments.createForQuote(quoteId, user.id);
    expect(first.created).toBe(true);
    expect(second).toMatchObject({ created: false, payment: { id: first.payment.id, status: 'SUBMITTED' } });

    const txHash = `0x${'EF'.repeat(32)}` as const;
    await repos.payments.update(first.payment.id, { payTxHash: txHash });
    await expect(repos.payments.transition(first.payment.id, 'PAID', 'PAYOUT_PENDING')).resolves.toBe(false);
    await expect(
      repos.payments.transition(first.payment.id, 'SUBMITTED', 'PAID', { paidBlock: 42n }),
    ).resolves.toBe(true);
    await expect(repos.payments.transition(first.payment.id, 'SUBMITTED', 'PAID')).resolves.toBe(false);
    await expect(repos.payments.transition(first.payment.id, 'PAID', 'SETTLED')).rejects.toThrow(/cannot move/);

    const found = await repos.payments.findById(first.payment.id);
    expect(found?.payment).toMatchObject({ status: 'PAID', payTxHash: txHash.toLowerCase(), paidBlock: 42n });
    expect(found?.quote.quote.quoteId).toBe(quoteId);
    await expect(repos.payments.findByQuoteId(quoteId)).resolves.toMatchObject({ id: first.payment.id });
  });

  it('lists payments by user (newest first) and by status (oldest first)', async () => {
    const user = await repos.users.upsertByWallet(PAYER);
    const ids: string[] = [];
    for (const n of [1, 2, 3]) {
      const quoteId = `0x${String(n).padStart(64, '0')}` as const;
      await storeQuote(user.id, quoteId, 10_00n);
      ids.push((await repos.payments.createForQuote(quoteId, user.id)).payment.id);
    }
    await repos.payments.transition(ids[1]!, 'SUBMITTED', 'FAILED', { failureReason: 'test' });

    expect((await repos.payments.listByUser(user.id, 2)).map((p) => p.payment.id)).toEqual([ids[2], ids[1]]);
    expect((await repos.payments.listByStatus(['SUBMITTED'], 10)).map((p) => p.payment.id)).toEqual([ids[0], ids[2]]);
    expect((await repos.payments.listByStatus(['FAILED'], 10))[0]?.payment.failureReason).toBe('test');

    // The chain shows the failed payment paid after all: it becomes PAID, and the failure reason goes.
    await expect(repos.payments.transition(ids[1]!, 'FAILED', 'PAID', { paidBlock: 7n, failureReason: null })).resolves.toBe(true);
    const corrected = (await repos.payments.findById(ids[1]!))?.payment;
    expect(corrected).toMatchObject({ status: 'PAID', paidBlock: 7n });
    expect(corrected?.failureReason).toBeUndefined();
  });

  it('keeps and lists payments whose on-chain event did not match their quote', async () => {
    const user = await repos.users.upsertByWallet(PAYER);
    const ids: string[] = [];
    for (const n of [1, 2]) {
      const quoteId = `0x${String(n).padStart(64, '0')}` as const;
      await storeQuote(user.id, quoteId, 10_00n);
      ids.push((await repos.payments.createForQuote(quoteId, user.id)).payment.id);
    }
    await expect(
      repos.payments.transition(ids[1]!, 'SUBMITTED', 'FAILED', { failureReason: 'mismatch', eventMismatch: 'tokenAmount 1 (quote: 3107693)' }),
    ).resolves.toBe(true);

    const listed = await repos.payments.listEventMismatches(10);
    expect(listed.map((p) => p.payment.id)).toEqual([ids[1]]);
    expect(listed[0]?.payment).toMatchObject({ status: 'FAILED', eventMismatch: 'tokenAmount 1 (quote: 3107693)' });
    expect((await repos.payments.findById(ids[0]!))?.payment.eventMismatch).toBeUndefined();
  });

  it('lists the payout-pending payments due a payout step, in pages', async () => {
    const user = await repos.users.upsertByWallet(PAYER);
    const now = new Date();
    const ids: string[] = [];
    for (const n of [1, 2, 3, 4, 5]) {
      const quoteId = `0x${String(n).padStart(64, '0')}` as const;
      await storeQuote(user.id, quoteId, 10_00n);
      const { payment } = await repos.payments.createForQuote(quoteId, user.id);
      await repos.payments.transition(payment.id, 'SUBMITTED', 'PAID');
      await repos.payments.transition(payment.id, 'PAID', 'PAYOUT_PENDING');
      ids.push(payment.id);
    }
    const amount = { currency: 'THB' as const, minor: 10_00n };
    const payout = (i: number) => repos.payouts.createForPayment({ paymentId: ids[i]!, provider: 'sim', amount, idempotencyKey: ids[i]! });
    // 0: no payout yet. 1: UNKNOWN, backing off. 2: UNKNOWN, due again. 3: SUCCEEDED, to settle. 4: REVERSED.
    for (const i of [1, 2, 3, 4]) await payout(i);
    await repos.payouts.transition(ids[1]!, 'PENDING', 'UNKNOWN', { nextCheckAt: new Date(now.getTime() + 60_000) });
    await repos.payouts.transition(ids[2]!, 'PENDING', 'UNKNOWN', { nextCheckAt: new Date(now.getTime() - 1_000) });
    await repos.payouts.transition(ids[3]!, 'PENDING', 'SUCCEEDED', { providerReference: 'REF' });
    await repos.payouts.transition(ids[4]!, 'PENDING', 'SUCCEEDED', { providerReference: 'REF' });
    await repos.payouts.transition(ids[4]!, 'SUCCEEDED', 'REVERSED');

    const due = await repos.payments.listPayoutDue(now, 10);
    expect(due.map((p) => p.payment.id)).toEqual([ids[0], ids[2], ids[3]]);
    const first = await repos.payments.listPayoutDue(now, 2);
    expect(first.map((p) => p.payment.id)).toEqual([ids[0], ids[2]]);
    const last = first.at(-1)!.payment;
    const rest = await repos.payments.listPayoutDue(now, 2, { createdAt: last.createdAt, id: last.id });
    expect(rest.map((p) => p.payment.id)).toEqual([ids[3]]);
  });

  it('creates one payout per payment, moves it only from the expected status, and keeps an audit trail', async () => {
    const user = await repos.users.upsertByWallet(PAYER);
    const quoteId = `0x${'cd'.repeat(32)}` as const;
    await storeQuote(user.id, quoteId, 100_00n);
    const { payment } = await repos.payments.createForQuote(quoteId, user.id);
    const amount = { currency: 'THB' as const, minor: 100_00n };

    await expect(repos.payouts.findByPaymentId(payment.id)).resolves.toBeNull();
    const created = await repos.payouts.createForPayment({
      paymentId: payment.id,
      provider: 'sim',
      amount,
      idempotencyKey: payment.id,
    });
    expect(created).toMatchObject({
      paymentId: payment.id,
      provider: 'sim',
      idempotencyKey: payment.id,
      status: 'PENDING',
      amount,
      attempts: 0,
    });
    await expect(
      repos.payouts.createForPayment({ paymentId: payment.id, provider: 'other', amount, idempotencyKey: 'other' }),
    ).resolves.toMatchObject({ provider: 'sim', idempotencyKey: payment.id });

    const unknownSince = new Date('2026-11-13T00:00:00Z');
    await repos.payouts.update(payment.id, { providerRef: 'po-1', attempts: 1, lastError: 'timeout' });
    await expect(repos.payouts.transition(payment.id, 'SUCCEEDED', 'REVERSED')).resolves.toBe(false);
    await expect(repos.payouts.transition(payment.id, 'PENDING', 'UNKNOWN', { unknownSince })).resolves.toBe(true);
    await expect(repos.payouts.transition(payment.id, 'FAILED', 'PENDING')).rejects.toThrow(/cannot move/);
    expect(await repos.payouts.listByStatus(['UNKNOWN'], 10)).toHaveLength(1);
    expect((await repos.payouts.listNeedingAttention(10)).map((p) => p.paymentId)).toEqual([payment.id]);
    await expect(repos.payouts.countByStatus()).resolves.toEqual({
      PENDING: 0,
      SUCCEEDED: 0,
      FAILED: 0,
      UNKNOWN: 1,
      REVERSED: 0,
    });

    await repos.payouts.transition(payment.id, 'UNKNOWN', 'SUCCEEDED', {
      providerReference: 'BANKREF123',
      unknownSince: null,
      lastError: null,
    });
    const settled = await repos.payouts.findByPaymentId(payment.id);
    expect(settled).toMatchObject({ status: 'SUCCEEDED', providerRef: 'po-1', providerReference: 'BANKREF123' });
    expect(settled?.unknownSince).toBeUndefined();
    expect(settled?.lastError).toBeUndefined();
    await expect(repos.payouts.listNeedingAttention(10)).resolves.toEqual([]);

    await repos.payouts.recordEvent(payment.id, { source: 'create', providerStatus: 'ACCEPTED', payload: { amount: 1n } });
    await repos.payouts.recordEvent(payment.id, { source: 'webhook', providerStatus: 'SUCCEEDED', payload: { ok: true } });
    const events = await repos.payouts.listEvents(payment.id, 10);
    expect(events.map((e) => e.source)).toEqual(['webhook', 'create']);
    expect(events[1]?.payload).toEqual({ amount: '1' });

    const action = await repos.opsActions.record({
      action: 'mark-paid',
      targetType: 'payout',
      targetId: payment.id,
      actor: 'ops',
      note: 'checked with the bank',
      details: { reference: 'BANKREF123' },
    });
    expect(action.id).toBeTruthy();
    await expect(repos.opsActions.list(10, { type: 'payout', id: payment.id })).resolves.toMatchObject([
      { action: 'mark-paid', note: 'checked with the bank', details: { reference: 'BANKREF123' } },
    ]);
  });

  it('keeps onramp orders, completing each on-chain transfer at most once', async () => {
    const user = await repos.users.upsertByWallet(PAYER);
    expect((await repos.users.listWallets()).map((u) => u.id)).toEqual([user.id]);
    const order = (n: number) =>
      repos.onrampOrders.create({
        userId: user.id,
        provider: 'moonpay',
        walletAddress: PAYER,
        fiat: { currency: 'THB', minor: BigInt(n) * 100_00n },
        expiresAt: new Date(Date.now() + 3_600_000),
      });
    const first = await order(8);
    const second = await order(9);
    expect(first).toMatchObject({ status: 'CREATED', walletAddress: PAYER.toLowerCase(), fiat: { currency: 'THB', minor: 800_00n } });
    await expect(repos.onrampOrders.countOpen(user.id)).resolves.toBe(2);
    expect((await repos.onrampOrders.listByUser(user.id, 10)).map((o) => o.id)).toEqual([second.id, first.id]);

    const txHash = `0x${'AB'.repeat(32)}` as const;
    await repos.onrampOrders.update(first.id, { providerTxId: 'mp-1', expectedTokenAmount: 24_000_000n });
    await expect(repos.onrampOrders.transition(first.id, 'CREATED', 'PENDING', { providerStatus: 'pending' })).resolves.toBe(true);
    await expect(repos.onrampOrders.transition(first.id, 'CREATED', 'PENDING')).resolves.toBe(false);
    await repos.onrampOrders.transition(first.id, 'PENDING', 'COMPLETED', { txHash, logIndex: 3, receivedAmount: 24_000_000n, lastError: null });
    expect(await repos.onrampOrders.findById(first.id)).toMatchObject({
      status: 'COMPLETED',
      txHash: txHash.toLowerCase(),
      logIndex: 3,
      expectedTokenAmount: 24_000_000n,
      receivedAmount: 24_000_000n,
    });

    // The same transfer can't complete a second order.
    await expect(
      repos.onrampOrders.transition(second.id, 'CREATED', 'COMPLETED', { txHash, logIndex: 3 }),
    ).rejects.toMatchObject({ code: 'transfer_already_counted' });
    expect((await repos.onrampOrders.listByStatus(['CREATED'], 10)).map((o) => o.id)).toEqual([second.id]);
    await expect(repos.onrampOrders.transition(second.id, 'COMPLETED', 'FAILED')).rejects.toThrow(/cannot move/);
  });

  it('lists the onramp orders due a check, in pages', async () => {
    const user = await repos.users.upsertByWallet(PAYER);
    const now = new Date();
    const order = () =>
      repos.onrampOrders.create({
        userId: user.id,
        provider: 'moonpay',
        walletAddress: PAYER,
        fiat: { currency: 'THB', minor: 800_00n },
        expiresAt: new Date(now.getTime() + 3_600_000),
      });
    const never = await order();
    const recent = await order();
    const stale = await order();
    const verifying = await order();
    const expired = await order();
    await repos.onrampOrders.update(recent.id, { lastCheckedAt: now });
    await repos.onrampOrders.update(stale.id, { lastCheckedAt: new Date(now.getTime() - 60_000) });
    await repos.onrampOrders.transition(verifying.id, 'CREATED', 'PENDING', { lastCheckedAt: now, txHash: `0x${'ab'.repeat(32)}` });
    await repos.onrampOrders.transition(expired.id, 'CREATED', 'EXPIRED');

    const checkedBefore = new Date(now.getTime() - 15_000);
    const open = await repos.onrampOrders.listDue({ statuses: ['CREATED', 'PENDING'], checkedBefore }, 10);
    expect(open.map((o) => o.id)).toEqual([never.id, stale.id, verifying.id]);
    const page = await repos.onrampOrders.listDue({ statuses: ['CREATED', 'PENDING'], checkedBefore, after: { createdAt: never.createdAt, id: never.id } }, 1);
    expect(page.map((o) => o.id)).toEqual([stale.id]);

    expect((await repos.onrampOrders.listDue({ statuses: ['EXPIRED'], checkedBefore, createdAfter: new Date(now.getTime() - 60_000) }, 10)).map((o) => o.id)).toEqual([
      expired.id,
    ]);
    await expect(repos.onrampOrders.listDue({ statuses: ['EXPIRED'], checkedBefore, createdAfter: new Date(now.getTime() + 60_000) }, 10)).resolves.toEqual([]);
  });

  it('stores each deposit once', async () => {
    const user = await repos.users.upsertByWallet(PAYER);
    const deposit = {
      userId: user.id,
      chainId: 84532,
      token: ANVIL.usdc,
      txHash: `0x${'cd'.repeat(32)}` as const,
      logIndex: 1,
      from: ANVIL.accounts.treasury.address,
      amount: 5_000_000n,
      blockNumber: 123n,
    };
    await expect(repos.deposits.record(deposit)).resolves.toBe(true);
    await expect(repos.deposits.record(deposit)).resolves.toBe(false);
    await expect(repos.deposits.record({ ...deposit, logIndex: 2 })).resolves.toBe(true);
    const listed = await repos.deposits.listByUser(user.id, 10);
    expect(listed).toHaveLength(2);
    expect(listed[1]).toMatchObject({ token: ANVIL.usdc.toLowerCase(), from: ANVIL.accounts.treasury.address.toLowerCase(), amount: 5_000_000n, blockNumber: 123n });
  });

  it('registers devices: one owner per key, push tokens moved and forgotten, revocation', async () => {
    const alice = await repos.users.upsertByWallet(PAYER);
    const bob = await repos.users.upsertByWallet(ANVIL.accounts.treasury.address);
    expect(await repos.users.updateProfile(alice.id, { displayName: 'Alice Shop' })).toMatchObject({ displayName: 'Alice Shop', nameVerified: false });

    const phone = await repos.devices.register({ userId: alice.id, publicKey: 'key-a', platform: 'android', fcmToken: 'token-1' });
    await expect(repos.devices.register({ userId: bob.id, publicKey: 'key-a', platform: 'android' })).rejects.toMatchObject({ code: 'device_taken' });
    // The same install registers a new key: the push token moves to it.
    const second = await repos.devices.register({ userId: alice.id, publicKey: 'key-b', platform: 'android', fcmToken: 'token-1' });
    expect((await repos.devices.findById(phone.id))?.fcmToken).toBeUndefined();
    expect((await repos.devices.findById(second.id))?.fcmToken).toBe('token-1');

    await repos.devices.forgetPushToken('token-1');
    expect((await repos.devices.findById(second.id))?.fcmToken).toBeUndefined();
    await expect(repos.devices.revoke(second.id, bob.id, new Date())).resolves.toBe(false);
    await expect(repos.devices.revoke(second.id, alice.id, new Date())).resolves.toBe(true);
    expect((await repos.devices.listActive(alice.id)).map((d) => d.id)).toEqual([phone.id]);
  });

  it('uses a request challenge once, and only before it expires', async () => {
    const receiver = await repos.users.upsertByWallet(PAYER);
    const sender = await repos.users.upsertByWallet(ANVIL.accounts.treasury.address);
    const now = new Date();
    const make = (n: number, expiresAt: Date) =>
      repos.paymentRequests.create({
        receiverId: receiver.id,
        receiverAddress: PAYER,
        recipientName: 'Alice Shop',
        nameVerified: false,
        token: ANVIL.usdc,
        amount: 5_000_000n,
        nonce: `0x${String(n).repeat(64)}`,
        challenge: `0x${String(n + 1).repeat(64)}`,
        validBefore: 1_900_000_000n,
        expiresAt,
      });
    const live = await make(1, new Date(now.getTime() + 60_000));
    const stale = await make(3, new Date(now.getTime() - 1_000));
    expect(live).toMatchObject({ status: 'CREATED', receiverAddress: PAYER.toLowerCase(), amount: 5_000_000n, validBefore: 1_900_000_000n });
    await expect(repos.paymentRequests.countOpenByReceiver(receiver.id)).resolves.toBe(2);

    const who = { senderId: sender.id, senderAddress: ANVIL.accounts.treasury.address, senderDeviceId: 'device-1' };
    await expect(repos.paymentRequests.identifySender(stale.id, who, now)).resolves.toBe(false);
    await expect(repos.paymentRequests.identifySender(live.id, who, now)).resolves.toBe(true);
    await expect(repos.paymentRequests.identifySender(live.id, who, now)).resolves.toBe(false);
    expect(await repos.paymentRequests.findById(live.id)).toMatchObject({
      status: 'SENDER_IDENTIFIED',
      senderId: sender.id,
      senderAddress: ANVIL.accounts.treasury.address.toLowerCase(),
      senderDeviceId: 'device-1',
    });
    expect((await repos.paymentRequests.listAwaitingSender(sender.id, now)).map((r) => r.id)).toEqual([live.id]);

    const txHash = `0x${'ab'.repeat(32)}` as const;
    await expect(repos.paymentRequests.transition(live.id, 'SENDER_IDENTIFIED', 'SUBMITTED', { txHash })).resolves.toBe(true);
    await expect(repos.paymentRequests.transition(live.id, 'SUBMITTED', 'EXPIRED')).rejects.toThrow(/cannot move/);
    expect((await repos.paymentRequests.findById(live.id))?.txHash).toBe(txHash);
    expect((await repos.paymentRequests.listByUser(sender.id, 10)).map((r) => r.id)).toEqual([live.id]);
    expect((await repos.paymentRequests.listByStatus(['CREATED'], 10)).map((r) => r.id)).toEqual([stale.id]);
  });

  it('saves the indexer cursor', async () => {
    await expect(repos.cursors.get('settlement:31337:0xabc')).resolves.toBeNull();
    await repos.cursors.set('settlement:31337:0xabc', 10n);
    await repos.cursors.set('settlement:31337:0xabc', 12n);
    await expect(repos.cursors.get('settlement:31337:0xabc')).resolves.toBe(12n);
  });
});
