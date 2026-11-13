import { beforeEach, describe, expect, it } from 'vitest';
import type { FiatAmount } from '../src/domain/money.js';
import { PayoutTracker } from '../src/modules/payouts/payout-tracker.js';
import type { PayoutProvider, PayoutRequest, PayoutResult } from '../src/ports/payout-provider.js';
import type { PaymentWithQuote } from '../src/ports/repositories.js';
import { type MemoryRepositories, createMemoryRepositories, seedPayment } from './support/memory-repositories.js';

/** A partner whose answers each test scripts. */
class ScriptedPartner implements PayoutProvider {
  readonly name = 'scripted';
  creates: PayoutRequest[] = [];
  gets: string[] = [];
  onCreate: (request: PayoutRequest) => PayoutResult = () => ({ status: 'pending', providerRef: 'ref-1' });
  onGet: (providerRef: string) => PayoutResult = (providerRef) => ({ status: 'pending', providerRef });
  onFind: (key: string) => PayoutResult | null = () => null;

  supports(): boolean {
    return true;
  }
  async createPayout(request: PayoutRequest): Promise<PayoutResult> {
    this.creates.push(request);
    return this.onCreate(request);
  }
  async getPayout(providerRef: string): Promise<PayoutResult> {
    this.gets.push(providerRef);
    return this.onGet(providerRef);
  }
  async findByIdempotencyKey(key: string): Promise<PayoutResult | null> {
    return this.onFind(key);
  }
  async getBalance(): Promise<FiatAmount | null> {
    return null;
  }
}

const MINUTE = 60_000;
let repos: MemoryRepositories;
let partner: ScriptedPartner;
let clock: number;
let tracker: PayoutTracker;
let item: PaymentWithQuote;

beforeEach(async () => {
  repos = createMemoryRepositories();
  partner = new ScriptedPartner();
  clock = Date.now();
  tracker = new PayoutTracker({
    payouts: repos.payouts,
    provider: partner,
    recheckMs: 0,
    pendingDeadlineMs: 30 * MINUTE,
    now: () => new Date(clock),
  });
  const payment = seedPayment(repos, { userId: 'u1', fiatMinor: 100_00n, status: 'PAYOUT_PENDING', createdAt: new Date() });
  item = (await repos.payments.findById(payment.id))!;
});

const stored = () => repos.state.payouts.get(item.payment.id);
const later = (ms: number) => {
  clock += ms;
};

describe('PayoutTracker', () => {
  it('creates the payout once, with the payment ID as idempotency key', async () => {
    await tracker.check(item);
    await tracker.check(item);
    expect(partner.creates).toHaveLength(1);
    expect(partner.creates[0]).toMatchObject({ idempotencyKey: item.payment.id, amount: { currency: 'THB', minor: 100_00n } });
    expect(stored()).toMatchObject({ status: 'PENDING', providerRef: 'ref-1', attempts: 1 });
  });

  it('looks the payout up before creating it again, so a retry never pays twice', async () => {
    // The first create timed out: the partner may or may not have the payout.
    partner.onCreate = () => ({ status: 'unknown', reason: 'Xendit timed out' });
    await tracker.check(item);
    expect(stored()).toMatchObject({ status: 'UNKNOWN', lastError: 'Xendit timed out' });

    // It did: the next check finds it by key instead of creating a second one.
    partner.onFind = () => ({ status: 'succeeded', providerRef: 'ref-9', reference: 'BANK-1' });
    later(MINUTE);
    await tracker.check(item);
    expect(partner.creates).toHaveLength(1);
    expect(stored()).toMatchObject({ status: 'SUCCEEDED', providerRef: 'ref-9', providerReference: 'BANK-1' });
    expect(stored()?.unknownSince).toBeUndefined();
  });

  it('creates again with the same key only when the partner has no such payout', async () => {
    partner.onCreate = () => ({ status: 'unknown', reason: 'Server error' });
    await tracker.check(item);
    partner.onCreate = () => ({ status: 'pending', providerRef: 'ref-2' });
    later(MINUTE);
    await tracker.check(item);
    expect(partner.creates.map((c) => c.idempotencyKey)).toEqual([item.payment.id, item.payment.id]);
    expect(stored()).toMatchObject({ status: 'PENDING', providerRef: 'ref-2', attempts: 2 });
  });

  it('settles only on a success with a reference', async () => {
    await tracker.check(item);
    partner.onGet = (providerRef) => ({ status: 'succeeded', providerRef });
    await tracker.check(item);
    expect(stored()).toMatchObject({ status: 'UNKNOWN', lastError: 'Partner reported success without a reference' });
  });

  it('fails only on a definite failure, and keeps the reason', async () => {
    await tracker.check(item);
    partner.onGet = (providerRef) => ({ status: 'failed', providerRef, reason: 'INVALID_DESTINATION' });
    await tracker.check(item);
    expect(stored()).toMatchObject({ status: 'FAILED', failureReason: 'INVALID_DESTINATION' });
  });

  it('turns a payout still pending after the deadline into UNKNOWN', async () => {
    await tracker.check(item);
    later(29 * MINUTE);
    await tracker.check(item);
    expect(stored()?.status).toBe('PENDING');
    later(2 * MINUTE);
    await tracker.check(item);
    expect(stored()).toMatchObject({ status: 'UNKNOWN', lastError: 'Still pending after 30 minutes' });
  });

  it('backs off an UNKNOWN payout as it ages', async () => {
    partner.onCreate = () => ({ status: 'pending', providerRef: 'ref-1' });
    await tracker.check(item);
    partner.onGet = (providerRef) => ({ status: 'unknown', providerRef, reason: 'Odd answer' });
    await tracker.check(item);
    const first = stored()!;
    expect(first.nextCheckAt!.getTime() - clock).toBe(30_000);

    // Not due yet: no partner call.
    const calls = partner.gets.length;
    await tracker.check(item);
    expect(partner.gets).toHaveLength(calls);

    // Two hours later the wait is capped at an hour.
    later(2 * 60 * MINUTE);
    await tracker.check(item);
    expect(stored()!.nextCheckAt!.getTime() - clock).toBe(60 * MINUTE);
  });

  it('records an unreachable partner without changing the status', async () => {
    await tracker.check(item);
    partner.onGet = () => {
      throw new Error('ECONNRESET');
    };
    await tracker.check(item);
    expect(stored()).toMatchObject({ status: 'PENDING', lastError: 'Partner unreachable: ECONNRESET' });
  });

  it('recovers from UNKNOWN when the partner answers again', async () => {
    partner.onCreate = () => ({ status: 'unknown', reason: 'Timeout' });
    await tracker.check(item);
    partner.onFind = () => ({ status: 'pending', providerRef: 'ref-3' });
    await tracker.check(item, { force: true });
    expect(stored()).toMatchObject({ status: 'PENDING', providerRef: 'ref-3' });
    expect(stored()?.lastError).toBeUndefined();
  });

  it('acts on a webhook only after fetching the payout from the partner', async () => {
    await tracker.check(item);
    partner.onGet = (providerRef) => ({ status: 'succeeded', providerRef, reference: 'BANK-7' });

    const result = await tracker.onWebhook({ idempotencyKey: item.payment.id, providerRef: 'ref-1' }, { claimed: 'SUCCEEDED' });
    expect(result).toBe('applied');
    expect(partner.gets).toContain('ref-1');
    expect(stored()).toMatchObject({ status: 'SUCCEEDED', providerReference: 'BANK-7' });
    const sources = repos.state.payoutEvents.map((e) => e.source);
    expect(sources).toEqual(['create', 'webhook', 'webhook']);
  });

  it('ignores a webhook about a payout it does not know', async () => {
    await expect(tracker.onWebhook({ idempotencyKey: 'someone-else' }, {})).resolves.toBe('ignored');
  });

  it('marks a settled payout REVERSED when the partner undoes it', async () => {
    partner.onCreate = () => ({ status: 'succeeded', providerRef: 'ref-1', reference: 'BANK-1' });
    await tracker.check(item);
    partner.onGet = (providerRef) => ({ status: 'reversed', providerRef, reason: 'Account closed' });
    await tracker.onWebhook({ idempotencyKey: item.payment.id }, {});
    expect(stored()).toMatchObject({ status: 'REVERSED', failureReason: 'Account closed' });
  });

  it('keeps every partner answer as an event', async () => {
    await tracker.check(item);
    partner.onGet = (providerRef) => ({ status: 'succeeded', providerRef, reference: 'BANK-1', providerStatus: 'SUCCEEDED' });
    await tracker.check(item);
    const events = await repos.payouts.listEvents(item.payment.id, 10);
    expect(events.map((e) => [e.source, e.providerStatus])).toEqual([
      ['check', 'SUCCEEDED'],
      ['create', undefined],
    ]);
  });
});
