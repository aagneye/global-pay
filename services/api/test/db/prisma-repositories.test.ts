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
      'TRUNCATE "Payout", "Payment", "Quote", "KycRecord", "SiweNonce", "User", "IndexerCursor" CASCADE',
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
  });

  it('creates one payout per payment and updates it', async () => {
    const user = await repos.users.upsertByWallet(PAYER);
    const quoteId = `0x${'cd'.repeat(32)}` as const;
    await storeQuote(user.id, quoteId, 100_00n);
    const { payment } = await repos.payments.createForQuote(quoteId, user.id);
    const amount = { currency: 'THB' as const, minor: 100_00n };

    await expect(repos.payouts.findByPaymentId(payment.id)).resolves.toBeNull();
    const created = await repos.payouts.createForPayment({ paymentId: payment.id, provider: 'sim', amount });
    expect(created).toEqual({ paymentId: payment.id, provider: 'sim', status: 'PENDING', amount, attempts: 0 });
    await expect(
      repos.payouts.createForPayment({ paymentId: payment.id, provider: 'other', amount }),
    ).resolves.toEqual(created);

    const updated = await repos.payouts.update(payment.id, {
      providerRef: 'ref-1',
      status: 'FAILED',
      failureReason: 'no',
      attempts: 1,
    });
    expect(updated).toMatchObject({ providerRef: 'ref-1', status: 'FAILED', failureReason: 'no', attempts: 1 });
  });

  it('saves the indexer cursor', async () => {
    await expect(repos.cursors.get('settlement:31337:0xabc')).resolves.toBeNull();
    await repos.cursors.set('settlement:31337:0xabc', 10n);
    await repos.cursors.set('settlement:31337:0xabc', 12n);
    await expect(repos.cursors.get('settlement:31337:0xabc')).resolves.toBe(12n);
  });
});
