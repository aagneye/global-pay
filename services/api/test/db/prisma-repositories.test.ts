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
});
