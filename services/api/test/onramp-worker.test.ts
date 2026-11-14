import type { Address, Hex } from 'viem';
import { beforeEach, describe, expect, it } from 'vitest';
import type { OnrampOrder } from '../src/domain/onramp.js';
import { OnrampTracker } from '../src/modules/onramp/onramp-tracker.js';
import type { OnrampProvider, OnrampResult } from '../src/ports/onramp-provider.js';
import { OnrampWorker } from '../src/workers/onramp-worker.js';
import { ANVIL } from './support/anvil.js';
import { FakeTokenChain } from './support/fake-token-chain.js';
import { type MemoryRepositories, createMemoryRepositories } from './support/memory-repositories.js';

const USDC = ANVIL.usdc;
const WALLET = ANVIL.accounts.payer.address;
const STRANGER: Address = '0x000000000000000000000000000000000000bEEF';
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

/** A partner with an answer per order, counting the calls for each. */
class PerOrderPartner implements OnrampProvider {
  readonly name = 'moonpay';
  readonly answers = new Map<string, OnrampResult>();
  readonly calls = new Map<string, number>();
  checkoutUrl(): string {
    return 'https://buy-sandbox.moonpay.com/?signed';
  }
  async findByOrderId(orderId: string): Promise<OnrampResult | null> {
    this.calls.set(orderId, (this.calls.get(orderId) ?? 0) + 1);
    return this.answers.get(orderId) ?? null;
  }
}

let repos: MemoryRepositories;
let chain: FakeTokenChain;
let partner: PerOrderPartner;
let clock: number;

const RECHECK_MS = 15_000;

function makeWorker(batchSize = 50) {
  const now = () => new Date(clock);
  const tracker = new OnrampTracker({ orders: repos.onrampOrders, provider: partner, reader: chain, token: USDC, confirmations: 0, recheckMs: RECHECK_MS, now });
  return new OnrampWorker({ orders: repos.onrampOrders, tracker, pollMs: 5_000, recheckMs: RECHECK_MS, batchSize, now });
}

/** An order made `ageMs` ago, expiring an hour after that. */
async function newOrder(ageMs = 0): Promise<OnrampOrder> {
  const order = await repos.onrampOrders.create({
    userId: 'user_1',
    provider: 'moonpay',
    walletAddress: WALLET,
    fiat: { currency: 'THB', minor: 800_00n },
    expiresAt: new Date(clock - ageMs + HOUR),
  });
  repos.state.onrampOrders.get(order.id)!.createdAt = new Date(clock - ageMs);
  return order;
}

const completed = (txHash: Hex, walletAddress: Address = WALLET): OnrampResult => ({
  status: 'completed',
  providerTxId: 'mp_1',
  providerStatus: 'completed',
  walletAddress,
  tokenAmount: 24_000_000n,
  txHash,
});
const status = (id: string) => repos.state.onrampOrders.get(id)?.status;

beforeEach(() => {
  repos = createMemoryRepositories();
  chain = new FakeTokenChain();
  partner = new PerOrderPartner();
  clock = Date.now();
});

describe('onramp worker', () => {
  it("doesn't let orders that can never finish keep newer ones waiting", async () => {
    const worker = makeWorker(2);
    // Two old orders the partner says it is sending to someone else: they stay CREATED.
    for (const order of [await newOrder(2 * HOUR), await newOrder(2 * HOUR)]) {
      partner.answers.set(order.id, completed(chain.pending(), STRANGER));
    }
    const fresh = await newOrder();
    partner.answers.set(fresh.id, completed(chain.send(USDC, [{ to: WALLET, value: 24_000_000n }])));

    await worker.tick();
    clock += 5_000;
    await worker.tick();
    expect(status(fresh.id)).toBe('COMPLETED');
  });

  it('asks the partner about an open order at most once per recheck period', async () => {
    const worker = makeWorker();
    const order = await newOrder();
    partner.answers.set(order.id, { status: 'waiting', providerTxId: 'mp_1', providerStatus: 'waitingPayment' });

    await worker.tick();
    clock += 5_000;
    await worker.tick();
    expect(partner.calls.get(order.id)).toBe(1);
    clock += RECHECK_MS;
    await worker.tick();
    expect(partner.calls.get(order.id)).toBe(2);
  });

  it('still completes an expired order if the payment turns up, checking it now and then for a day', async () => {
    const worker = makeWorker();
    const order = await newOrder(2 * HOUR);
    const old = await newOrder(25 * HOUR);
    for (const o of [order, old]) await repos.onrampOrders.transition(o.id, 'CREATED', 'EXPIRED');

    // The user paid late: the partner now reports a delivery.
    partner.answers.set(order.id, completed(chain.send(USDC, [{ to: WALLET, value: 24_000_000n }])));
    partner.answers.set(old.id, completed(chain.send(USDC, [{ to: WALLET, value: 24_000_000n }])));
    await worker.tick();
    expect(status(order.id)).toBe('COMPLETED');
    // Expired more than a day ago: left to webhooks and the user opening it.
    expect(status(old.id)).toBe('EXPIRED');
    expect(partner.calls.get(old.id)).toBeUndefined();
  });

  it('re-checks an expired order less often than an open one', async () => {
    const worker = makeWorker();
    const order = await newOrder(2 * HOUR);
    await repos.onrampOrders.transition(order.id, 'CREATED', 'EXPIRED');

    await worker.tick();
    expect(partner.calls.get(order.id)).toBe(1);
    clock += RECHECK_MS;
    await worker.tick();
    expect(partner.calls.get(order.id)).toBe(1);
    clock += 5 * MINUTE;
    await worker.tick();
    expect(partner.calls.get(order.id)).toBe(2);
  });
});
