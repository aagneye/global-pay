import type { Address, Hex } from 'viem';
import { beforeEach, describe, expect, it } from 'vitest';
import type { OnrampOrder } from '../src/domain/onramp.js';
import { OnrampTracker } from '../src/modules/onramp/onramp-tracker.js';
import type { OnrampProvider, OnrampResult } from '../src/ports/onramp-provider.js';
import { ANVIL } from './support/anvil.js';
import { FakeTokenChain } from './support/fake-token-chain.js';
import { type MemoryRepositories, createMemoryRepositories } from './support/memory-repositories.js';

const USDC = ANVIL.usdc;
const WALLET = ANVIL.accounts.payer.address;
const STRANGER: Address = '0x000000000000000000000000000000000000bEEF';
const MINUTE = 60_000;

/** A partner whose answer each test sets. */
class ScriptedPartner implements OnrampProvider {
  readonly name = 'moonpay';
  answer: OnrampResult | null = null;
  calls = 0;
  checkoutUrl(): string {
    return 'https://buy-sandbox.moonpay.com/?signed';
  }
  async findByOrderId(): Promise<OnrampResult | null> {
    this.calls++;
    return this.answer;
  }
}

let repos: MemoryRepositories;
let chain: FakeTokenChain;
let partner: ScriptedPartner;
let clock: number;
let tracker: OnrampTracker;

function makeTracker(confirmations = 0, recheckMs = 0) {
  return new OnrampTracker({ orders: repos.onrampOrders, provider: partner, reader: chain, token: USDC, confirmations, recheckMs, now: () => new Date(clock) });
}

async function newOrder(): Promise<OnrampOrder> {
  return repos.onrampOrders.create({
    userId: 'user_1',
    provider: 'moonpay',
    walletAddress: WALLET,
    fiat: { currency: 'THB', minor: 800_00n },
    expiresAt: new Date(clock + 60 * MINUTE),
  });
}
const completed = (txHash: Hex, extra: Partial<OnrampResult> = {}): OnrampResult => ({
  status: 'completed',
  providerTxId: 'mp_1',
  providerStatus: 'completed',
  walletAddress: WALLET,
  tokenAmount: 24_000_000n,
  txHash,
  ...extra,
});
const stored = (id: string) => repos.state.onrampOrders.get(id);

beforeEach(() => {
  repos = createMemoryRepositories();
  chain = new FakeTokenChain();
  partner = new ScriptedPartner();
  clock = Date.now();
  tracker = makeTracker();
});

describe('OnrampTracker', () => {
  it('completes an order only once the transfer is on-chain, for the reported amount', async () => {
    const order = await newOrder();
    const hash = chain.pending();
    partner.answer = completed(hash);

    // The partner says completed, but the chain doesn't have the transfer yet.
    await tracker.check(order);
    expect(stored(order.id)).toMatchObject({ status: 'PENDING', txHash: hash, expectedTokenAmount: 24_000_000n });
    expect(stored(order.id)?.lastError).toMatch(/Waiting for the delivery transaction/);

    const mined = chain.send(USDC, [{ to: STRANGER, value: 1n }, { to: WALLET, value: 24_000_000n }]);
    partner.answer = completed(mined);
    await tracker.check(order);
    expect(stored(order.id)).toMatchObject({ status: 'COMPLETED', txHash: mined, logIndex: 1, receivedAmount: 24_000_000n });
    expect(stored(order.id)?.lastError).toBeUndefined();
  });

  it('waits for confirmations', async () => {
    tracker = makeTracker(2);
    const order = await newOrder();
    partner.answer = completed(chain.send(USDC, [{ to: WALLET, value: 24_000_000n }]));
    await tracker.check(order);
    expect(stored(order.id)).toMatchObject({ status: 'PENDING', lastError: 'Waiting for confirmations' });
    chain.mine(2);
    await tracker.verify(stored(order.id)!);
    expect(stored(order.id)?.status).toBe('COMPLETED');
  });

  it.each([
    ['the wrong amount', () => chain.send(USDC, [{ to: WALLET, value: 23_999_999n }])],
    ['the wrong recipient', () => chain.send(USDC, [{ to: STRANGER, value: 24_000_000n }])],
    ['another token', () => chain.send(STRANGER, [{ to: WALLET, value: 24_000_000n }])],
  ])('never completes on a transfer of %s', async (_name, send) => {
    const order = await newOrder();
    partner.answer = completed(send());
    await tracker.check(order);
    expect(stored(order.id)).toMatchObject({ status: 'PENDING', lastError: expect.stringMatching(/no transfer of the expected amount/) });
  });

  it('counts each transfer once, so one delivery cannot complete two orders', async () => {
    const first = await newOrder();
    const second = await newOrder();
    const hash = chain.send(USDC, [{ to: WALLET, value: 24_000_000n }]);
    partner.answer = completed(hash);
    await tracker.check(first);
    await tracker.check(second);
    expect(stored(first.id)?.status).toBe('COMPLETED');
    expect(stored(second.id)).toMatchObject({ status: 'PENDING', lastError: expect.stringMatching(/already completed another order/) });
  });

  it('ignores a partner sending to another wallet', async () => {
    const order = await newOrder();
    partner.answer = completed(chain.send(USDC, [{ to: STRANGER, value: 24_000_000n }]), { walletAddress: STRANGER });
    await tracker.check(order);
    expect(stored(order.id)).toMatchObject({ status: 'CREATED', lastError: expect.stringMatching(/not the order's wallet/) });
  });

  it('keeps the order pending when the delivery reverted', async () => {
    const order = await newOrder();
    partner.answer = completed(chain.send(USDC, [{ to: WALLET, value: 24_000_000n }], 'reverted'));
    await tracker.check(order);
    expect(stored(order.id)).toMatchObject({ status: 'PENDING', lastError: 'The delivery transaction reverted' });
  });

  it('fails when the partner says so, and records the reason', async () => {
    const order = await newOrder();
    partner.answer = { status: 'failed', providerTxId: 'mp_1', providerStatus: 'failed', failureReason: 'Card declined' };
    await tracker.check(order);
    expect(stored(order.id)).toMatchObject({ status: 'FAILED', failureReason: 'Card declined' });
  });

  it('expires an unpaid order, and brings it back if the user pays after all', async () => {
    const order = await newOrder();
    partner.answer = { status: 'waiting', providerTxId: 'mp_1', providerStatus: 'waitingPayment' };
    await tracker.expireIfDue(order);
    expect(stored(order.id)?.status).toBe('CREATED');

    clock += 61 * MINUTE;
    await tracker.expireIfDue(stored(order.id)!);
    expect(stored(order.id)?.status).toBe('EXPIRED');

    partner.answer = completed(chain.send(USDC, [{ to: WALLET, value: 24_000_000n }]));
    await expect(tracker.onWebhook({ orderId: order.id })).resolves.toBe('applied');
    expect(stored(order.id)?.status).toBe('COMPLETED');
  });

  it('asks the partner at most once per recheck period, unless forced', async () => {
    tracker = makeTracker(0, 15_000);
    const order = await newOrder();
    partner.answer = { status: 'waiting', providerTxId: 'mp_1', providerStatus: 'waitingPayment' };
    await tracker.check(order);
    await tracker.check(stored(order.id)!);
    expect(partner.calls).toBe(1);
    await tracker.check(stored(order.id)!, { force: true });
    expect(partner.calls).toBe(2);
  });

  it('records an unreachable partner without changing anything', async () => {
    const order = await newOrder();
    partner.findByOrderId = async () => {
      throw new Error('ETIMEDOUT');
    };
    await tracker.check(order);
    expect(stored(order.id)).toMatchObject({ status: 'CREATED', lastError: 'Partner unreachable: ETIMEDOUT' });
  });

  it("ignores webhooks about orders it doesn't know", async () => {
    await expect(tracker.onWebhook({ orderId: 'nope' })).resolves.toBe('ignored');
    await expect(tracker.onWebhook({})).resolves.toBe('ignored');
  });
});
