import type { Hex } from 'viem';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NearSettlementGateway } from '../src/adapters/near/near-settlement-gateway.js';
import { buildPromptPayQr } from '../src/lib/promptpay/build.js';
import { ChainUnavailableError, TransactionRejectedError } from '../src/ports/settlement-gateway.js';
import { type TestApp, buildTestApp } from './support/app.js';
import { FakeNearGateway, RecordingOnboarding } from './support/fake-near.js';
import { FakeNearRpc } from './support/fake-near-rpc.js';
import { seedPayment } from './support/memory-repositories.js';
import { NEAR, type NearPaymentJson, implicitAccount, nearEnv, nearSignIn, nearTestKey, signNearPayment } from './support/near.js';

const qr = buildPromptPayQr({
  kind: 'merchant',
  targetType: 'biller',
  targetId: '099999999999901',
  amount: { currency: 'THB', minor: 100_00n },
});
const PAYER = implicitAccount(NEAR.payerKey);
const STRANGER = nearTestKey('edge-stranger');

vi.setConfig({ testTimeout: 30_000 });

let testApp: TestApp | undefined;

afterEach(async () => {
  await testApp?.app.close();
  testApp = undefined;
});

interface QuoteBody {
  quote: { quoteId: string; tokenAmount: string };
  nearPayment: NearPaymentJson;
}

/**
 * settle (or refund) lands, but the contract's USDC transfer fails, so it returns `false` and rolls the
 * payment back to Paid: the gateway reports that as a reverted transaction.
 */
class RollingBackGateway extends FakeNearGateway {
  constructor(private readonly rollBack: 'settle' | 'refund', private times = 1) {
    super();
  }

  override async markSettled(quoteId: Hex): Promise<Hex> {
    return this.maybeRollBack('settle', quoteId, await super.markSettled(quoteId));
  }

  override async refund(quoteId: Hex): Promise<Hex> {
    return this.maybeRollBack('refund', quoteId, await super.refund(quoteId));
  }

  private maybeRollBack(kind: 'settle' | 'refund', quoteId: Hex, hash: Hex): Hex {
    if (kind === this.rollBack && this.times > 0) {
      this.times -= 1;
      this.receipts.set(hash, { status: 'reverted', blockNumber: this.finalHeight });
      const payment = this.paid.find((p) => p.event.quoteId === quoteId);
      if (payment) payment.status = 'Paid';
    }
    return hash;
  }
}

async function setup(env: Record<string, string> = {}, near: FakeNearGateway = new FakeNearGateway()) {
  near.setAccessKey(PAYER, NEAR.payerKey.getPublicKey().toString(), 41n);
  testApp = await buildTestApp({
    env: nearEnv({ PAYOUT_DELAY_MS: '0', PAYOUT_FAILURE_RATE: '0', ...env }),
    adapters: { nearGateway: near, nearOnboarding: new RecordingOnboarding() },
  });
  const { app, container, repos } = testApp;
  const session = await nearSignIn(app);
  await app.inject({ method: 'POST', url: '/kyc/start', headers: session.auth });
  await app.inject({ method: 'GET', url: '/kyc/status', headers: session.auth });

  async function quote(): Promise<QuoteBody> {
    const response = await app.inject({ method: 'POST', url: '/quotes', headers: session.auth, payload: { payer: PAYER, qrPayload: qr } });
    if (response.statusCode !== 201) throw new Error(`quote failed: ${response.body}`);
    return response.json<QuoteBody>();
  }
  const submit = (quoteId: string, signedDelegate: string, auth = session.auth) =>
    app.inject({ method: 'POST', url: '/payments', headers: auth, payload: { quoteId, signedDelegate } });
  const status = (id: string) => repos.state.payments.get(id)?.status;
  return { app, container, repos, near, session, quote, submit, status };
}

describe('NEAR payments: quote and delegate edge cases', () => {
  it('refuses a quote that expired before POST /payments, relaying nothing and storing no payment', async () => {
    const { near, repos, quote, submit } = await setup();
    const q = await quote();
    const signedDelegate = await signNearPayment(NEAR.payerKey, q.nearPayment);
    repos.state.quotes.get(q.quote.quoteId)!.quote.expiresAt = new Date(Date.now() - 1_000);

    const response = await submit(q.quote.quoteId, signedDelegate);
    expect(response.statusCode).toBe(422);
    expect(response.json().error).toBe('quote_expired');
    expect(near.sent).toEqual([]);
    expect(repos.state.payments.size).toBe(0);
  });

  it('returns the same payment when the same signed delegate is replayed, relaying it once', async () => {
    const { near, quote, submit } = await setup();
    const q = await quote();
    const signedDelegate = await signNearPayment(NEAR.payerKey, q.nearPayment);

    const first = await submit(q.quote.quoteId, signedDelegate);
    const second = await submit(q.quote.quoteId, signedDelegate);
    // A fresh signature over the same quote is a replay too.
    const third = await submit(q.quote.quoteId, await signNearPayment(NEAR.payerKey, q.nearPayment));

    expect(first.statusCode).toBe(202);
    expect(second.statusCode).toBe(202);
    expect(second.json().id).toBe(first.json().id);
    expect(third.json().id).toBe(first.json().id);
    expect(near.sent.filter((s) => s.kind === 'delegate')).toHaveLength(1);
  });

  it("refuses a delegate signed for one quote when it is sent for another (the msg is the first quote's)", async () => {
    const { near, repos, quote, submit } = await setup();
    const first = await quote();
    const second = await quote();
    const forFirst = await signNearPayment(NEAR.payerKey, first.nearPayment);

    const response = await submit(second.quote.quoteId, forFirst);
    expect(response.statusCode).toBe(422);
    expect(response.json()).toMatchObject({ error: 'invalid_authorization' });
    expect(response.json().message).toMatch(/msg is not this quote's/);
    expect(near.sent).toEqual([]);
    expect(repos.state.payments.size).toBe(0);
  });

  it('refuses every tampered delegate over HTTP, with nothing relayed and no payment stored', async () => {
    const { near, repos, quote, submit } = await setup();
    const q = await quote();
    const p = q.nearPayment;
    const cases: [string, () => Promise<string>, RegExp][] = [
      ['another amount', () => signNearPayment(NEAR.payerKey, p, { args: { ...p.args, amount: (BigInt(p.args.amount) - 1n).toString() } }), /amount/],
      ['another token contract', () => signNearPayment(NEAR.payerKey, p, { receiverId: 'evil-usdc.testnet' }), /not the USDC contract/],
      ['another settlement receiver', () => signNearPayment(NEAR.payerKey, p, { args: { ...p.args, receiver_id: 'evil.testnet' } }), /settlement contract/],
      ['another method', () => signNearPayment(NEAR.payerKey, p, { methodName: 'ft_transfer' }), /is not ft_transfer_call/],
      ['an edited msg', () => signNearPayment(NEAR.payerKey, p, { args: { ...p.args, msg: p.args.msg.replace('"fiat_amount\\":\\"10000\\"', '"fiat_amount\\":\\"1\\"') } }), /msg/],
      ['a deposit of 0', () => signNearPayment(NEAR.payerKey, p, { deposit: 0n }), /exactly 1 yoctoNEAR/],
      ['a deposit of 1 NEAR', () => signNearPayment(NEAR.payerKey, p, { deposit: 10n ** 24n }), /exactly 1 yoctoNEAR/],
      [
        'another signer',
        () => signNearPayment(STRANGER, { ...p, signerId: implicitAccount(STRANGER), publicKey: STRANGER.getPublicKey().toString() }),
        /is not the payer/,
      ],
      ["the payer's name with another key", () => signNearPayment(STRANGER, p, { publicKey: STRANGER.getPublicKey() }), /implicit account key/],
      ['two calls', () => signNearPayment(NEAR.payerKey, p, { extraAction: true }), /exactly one action/],
      ['a block height that has passed', () => signNearPayment(NEAR.payerKey, p, { maxBlockHeight: near.finalHeight }), /expired/],
      ['bytes that are not a SignedDelegate', async () => Buffer.from('not a delegate').toString('base64'), /not a borsh SignedDelegate/],
    ];

    for (const [name, build, reason] of cases) {
      const response = await submit(q.quote.quoteId, await build());
      expect(response.statusCode, name).toBe(422);
      expect(response.json().error, name).toBe('invalid_authorization');
      expect(response.json().message, name).toMatch(reason);
    }
    expect(near.sent).toEqual([]);
    expect(repos.state.payments.size).toBe(0);

    // The untouched delegate still pays: the refusals left nothing behind.
    const ok = await submit(q.quote.quoteId, await signNearPayment(NEAR.payerKey, p));
    expect(ok.statusCode).toBe(202);
  });
});

describe('NEAR payments: other users', () => {
  it("returns 404 when one user pays another user's quote, even with the owner's signed delegate", async () => {
    const { app, near, repos, quote, submit } = await setup();
    const q = await quote();
    const signedDelegate = await signNearPayment(NEAR.payerKey, q.nearPayment);
    const other = await nearSignIn(app, STRANGER);

    const response = await submit(q.quote.quoteId, signedDelegate, other.auth);
    expect(response.statusCode).toBe(404);
    expect(response.json().error).toBe('quote_not_found');
    expect(near.sent).toEqual([]);
    expect(repos.state.payments.size).toBe(0);
  });

  it("hides one user's payment from another: GET /payments/{id} is 404 and their history is empty", async () => {
    const { app, quote, submit } = await setup();
    const q = await quote();
    const { id } = (await submit(q.quote.quoteId, await signNearPayment(NEAR.payerKey, q.nearPayment))).json<{ id: string }>();
    const other = await nearSignIn(app, STRANGER);

    const peek = await app.inject({ method: 'GET', url: `/payments/${id}`, headers: other.auth });
    expect(peek.statusCode).toBe(404);
    expect(peek.json().error).toBe('payment_not_found');
    const history = await app.inject({ method: 'GET', url: '/me/payments', headers: other.auth });
    expect(history.json().payments).toEqual([]);
    const missing = await app.inject({ method: 'GET', url: '/payments/payment_does_not_exist', headers: other.auth });
    expect(missing.statusCode).toBe(404);
  });

  it('needs a signed-in user to read a payment or the history', async () => {
    const { app } = await setup();
    expect((await app.inject({ method: 'GET', url: '/payments/payment_1' })).statusCode).toBe(401);
    expect((await app.inject({ method: 'GET', url: '/me/payments' })).statusCode).toBe(401);
  });
});

describe('NEAR payments: GET /me/payments', () => {
  it("lists only the user's own payments, newest first, capped at the last 50", async () => {
    const { app, repos, session } = await setup();
    const base = Date.now() - 1_000_000;
    const seeded = Array.from({ length: 53 }, (_, i) =>
      seedPayment(repos, { userId: session.userId, fiatMinor: 100_00n + BigInt(i), status: 'SETTLED', createdAt: new Date(base + i * 1_000) }),
    );
    seedPayment(repos, { userId: 'someone-else', fiatMinor: 1n, status: 'SETTLED', createdAt: new Date() });

    const response = await app.inject({ method: 'GET', url: '/me/payments', headers: session.auth });
    expect(response.statusCode).toBe(200);
    const ids = response.json<{ payments: { id: string }[] }>().payments.map((p) => p.id);
    expect(ids).toHaveLength(50);
    expect(ids).toEqual(seeded.slice(3).reverse().map((p) => p.id));
  });
});

describe('NEAR payments: the relayer failing', () => {
  it('fails the payment, with a 503, when the RPC is unreachable before anything is sent; a retry returns it FAILED', async () => {
    const { near, quote, submit, status } = await setup();
    const q = await quote();
    const signedDelegate = await signNearPayment(NEAR.payerKey, q.nearPayment);
    near.failNextWrite = new ChainUnavailableError('connect ECONNREFUSED rpc.testnet.near.org');

    const response = await submit(q.quote.quoteId, signedDelegate);
    expect(response.statusCode).toBe(503);
    expect(response.json().error).toBe('chain_unavailable');
    const [stored] = testApp!.repos.state.payments.values();
    expect(status(stored!.id)).toBe('FAILED');

    // Not stuck: the same quote now answers with the FAILED payment, and nothing is relayed twice.
    const retry = await submit(q.quote.quoteId, signedDelegate);
    expect(retry.statusCode).toBe(202);
    expect(retry.json()).toMatchObject({ id: stored!.id, status: 'FAILED' });
    expect(near.sent).toEqual([]);
  });

  it('fails the payment with the reason when the node refuses the transaction', async () => {
    const { app, near, quote, session, submit } = await setup();
    const q = await quote();
    near.failNextWrite = new TransactionRejectedError('InvalidNonce');

    const response = await submit(q.quote.quoteId, await signNearPayment(NEAR.payerKey, q.nearPayment));
    expect(response.statusCode).toBe(422);
    expect(response.json()).toMatchObject({ error: 'payment_rejected', message: 'The payment would fail on-chain: InvalidNonce' });
    const [payment] = (await app.inject({ method: 'GET', url: '/me/payments', headers: session.auth })).json().payments;
    expect(payment).toMatchObject({ status: 'FAILED', failureReason: 'InvalidNonce' });
  });

  it('keeps a maybe-sent payment SUBMITTED with its hash, then fails it once the quote expired with nothing on-chain', async () => {
    const { container, near, repos, quote, submit, status } = await setup();
    const q = await quote();
    const hash = '7hV4u3sFz8zK1nB2pQ6rT9wX3yA5cD8eF1gH4jK7mN2p' as Hex;
    near.failNextWrite = new ChainUnavailableError('socket hang up after broadcast', hash);

    const response = await submit(q.quote.quoteId, await signNearPayment(NEAR.payerKey, q.nearPayment));
    expect(response.statusCode).toBe(202);
    expect(response.json()).toMatchObject({ status: 'SUBMITTED', transactions: { pay: { hash, url: `https://testnet.nearblocks.io/txns/${hash}` } } });
    const { id } = response.json<{ id: string }>();

    await container.workers.indexer.tick();
    expect(status(id)).toBe('SUBMITTED'); // the quote is still live: it may land

    repos.state.quotes.get(q.quote.quoteId)!.quote.expiresAt = new Date(Date.now() - 10 * 60_000);
    await container.workers.indexer.tick();
    expect(status(id)).toBe('FAILED');
    expect(repos.state.payments.get(id)?.failureReason).toBe('pay() was not mined before the quote expired');
  });

  it('keeps an unexpected relayer error SUBMITTED, and marks it PAID if the delegate did land', async () => {
    const { container, near, quote, submit, status } = await setup();
    const q = await quote();
    const signedDelegate = await signNearPayment(NEAR.payerKey, q.nearPayment);
    // The relayer crashes after the transaction went out: emulate it landing anyway.
    const realSubmit = near.submitPayment.bind(near);
    near.submitPayment = async (...args) => {
      await realSubmit(...args);
      throw new Error('relayer process crashed');
    };

    const response = await submit(q.quote.quoteId, signedDelegate);
    expect(response.statusCode).toBe(202);
    const { id } = response.json<{ id: string }>();
    expect(status(id)).toBe('SUBMITTED');

    await container.workers.indexer.tick();
    expect(status(id)).toBe('PAID');
  });
});

describe('NEAR payments: settle or refund returning false', () => {
  async function paidAndPending(near: FakeNearGateway, env: Record<string, string> = {}) {
    const ctx = await setup(env, near);
    const q = await ctx.quote();
    const { id } = (await ctx.submit(q.quote.quoteId, await signNearPayment(NEAR.payerKey, q.nearPayment))).json<{ id: string }>();
    await ctx.container.workers.indexer.tick();
    expect(ctx.status(id)).toBe('PAID');
    return { ...ctx, id, quoteId: q.quote.quoteId };
  }

  it('counts a settle that returned false as reverted: not SETTLED, the error recorded, and settled on the next try', async () => {
    const near = new RollingBackGateway('settle');
    const { container, repos, id, quoteId, status } = await paidAndPending(near);

    for (let i = 0; i < 5 && !near.sent.some((s) => s.kind === 'settle'); i++) await container.workers.payouts.tick();
    expect(status(id)).toBe('PAYOUT_PENDING');
    expect(repos.state.payouts.get(id)).toMatchObject({ status: 'SUCCEEDED', lastError: 'markSettled transaction reverted' });
    expect(await near.getPaymentStatus(quoteId as Hex)).toBe('Paid');

    await container.workers.payouts.tick();
    expect(status(id)).toBe('SETTLED');
    expect(near.sent.map((s) => s.kind)).toEqual(['delegate', 'settle', 'settle']);
  });

  it('counts a refund that returned false as reverted: not REFUNDED until a refund lands', async () => {
    const near = new RollingBackGateway('refund');
    const { container, repos, id, status } = await paidAndPending(near, { PAYOUT_FAILURE_RATE: '1' });

    for (let i = 0; i < 5 && !near.sent.some((s) => s.kind === 'refund'); i++) await container.workers.payouts.tick();
    expect(status(id)).toBe('PAYOUT_PENDING');
    expect(repos.state.payouts.get(id)).toMatchObject({ status: 'FAILED', lastError: 'refund transaction reverted' });

    await container.workers.payouts.tick();
    expect(status(id)).toBe('REFUNDED');
    expect(near.sent.map((s) => s.kind)).toEqual(['delegate', 'refund', 'refund']);
  });

  it('keeps retrying, never SETTLED, while every settle returns false', async () => {
    const near = new RollingBackGateway('settle', Number.POSITIVE_INFINITY);
    const { container, id, status } = await paidAndPending(near);
    for (let i = 0; i < 6; i++) await container.workers.payouts.tick();
    expect(status(id)).toBe('PAYOUT_PENDING');
    expect(near.sent.filter((s) => s.kind === 'refund')).toEqual([]);
    expect(near.sent.filter((s) => s.kind === 'settle').length).toBeGreaterThanOrEqual(2);
  });
});

describe('NearSettlementGateway: a false return value', () => {
  it('reads SuccessValue false as reverted even when every receipt succeeded, and only exact false', async () => {
    const rpc = new FakeNearRpc();
    const gateway = new NearSettlementGateway({
      rpcUrl: 'http://near.test',
      settlementContract: NEAR.settlement,
      relayerAccountId: NEAR.relayer,
      relayerPrivateKey: NEAR.relayerKey.toString(),
      fetch: rpc.fetch,
    });
    const b64 = (text: string) => Buffer.from(text).toString('base64');
    const outcome = (value: string) => ({
      final_execution_status: 'FINAL',
      status: { SuccessValue: value },
      transaction_outcome: { id: 'x', block_hash: rpc.blockHash, outcome: { status: { SuccessReceiptId: 'r' } } },
      receipts_outcome: [{ id: 'r', block_hash: rpc.blockHash, outcome: { status: { SuccessValue: '' } } }],
    });
    rpc.txStatuses.set('false', outcome(b64('false')));
    rpc.txStatuses.set('true', outcome(b64('true')));
    rpc.txStatuses.set('empty', outcome(''));
    rpc.txStatuses.set('quoted-false', outcome(b64('"false"')));

    expect((await gateway.getReceipt('false' as Hex))?.status).toBe('reverted');
    expect((await gateway.getReceipt('true' as Hex))?.status).toBe('success');
    expect((await gateway.getReceipt('empty' as Hex))?.status).toBe('success');
    expect((await gateway.getReceipt('quoted-false' as Hex))?.status).toBe('success');
  });
});
