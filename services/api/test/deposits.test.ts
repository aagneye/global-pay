import type { Address } from 'viem';
import { describe, expect, it } from 'vitest';
import { OnrampTracker } from '../src/modules/onramp/onramp-tracker.js';
import { DepositWorker } from '../src/workers/deposit-worker.js';
import { OnrampWorker } from '../src/workers/onramp-worker.js';
import { ANVIL } from './support/anvil.js';
import { FakeTokenChain } from './support/fake-token-chain.js';
import { createMemoryRepositories } from './support/memory-repositories.js';

const USDC = ANVIL.usdc;
const SETTLEMENT = ANVIL.settlement;
const STRANGER: Address = '0x000000000000000000000000000000000000bEEF';

async function setup(confirmations = 0) {
  const repos = createMemoryRepositories();
  const chain = new FakeTokenChain();
  const alice = await repos.users.upsertByWallet(ANVIL.accounts.payer.address);
  const worker = new DepositWorker({
    users: repos.users,
    deposits: repos.deposits,
    cursors: repos.cursors,
    reader: chain,
    token: USDC,
    ignoreFrom: [SETTLEMENT],
    startBlock: chain.block + 1n,
    confirmations,
    maxBlockRange: 3n,
    pollMs: 60_000,
  });
  return { repos, chain, alice, worker };
}

describe('deposit watcher', () => {
  it("records USDC sent to a user's wallet, once, across block ranges", async () => {
    const { repos, chain, alice, worker } = await setup();
    chain.send(USDC, [{ from: STRANGER, to: alice.walletAddress, value: 5_000_000n }]);
    chain.mine(5); // more than one block range
    chain.send(USDC, [{ from: STRANGER, to: alice.walletAddress, value: 7_000_000n }]);

    await worker.tick();
    await worker.tick();
    const deposits = await repos.deposits.listByUser(alice.id, 10);
    expect(deposits.map((d) => d.amount)).toEqual([7_000_000n, 5_000_000n]);
    expect(deposits[0]).toMatchObject({ chainId: 31337, from: STRANGER.toLowerCase(), token: USDC.toLowerCase() });
    expect([...repos.state.cursors.values()]).toEqual([chain.block]);
  });

  it('skips refunds from the settlement contract, other tokens, and strangers', async () => {
    const { repos, chain, alice, worker } = await setup();
    chain.send(USDC, [{ from: SETTLEMENT, to: alice.walletAddress, value: 1_000_000n }]);
    chain.send(STRANGER, [{ from: STRANGER, to: alice.walletAddress, value: 1_000_000n }]);
    chain.send(USDC, [{ from: alice.walletAddress, to: STRANGER, value: 1_000_000n }]);
    await worker.tick();
    expect(await repos.deposits.listByUser(alice.id, 10)).toEqual([]);
  });

  it('waits for confirmations', async () => {
    const { repos, chain, alice, worker } = await setup(2);
    chain.send(USDC, [{ from: STRANGER, to: alice.walletAddress, value: 5_000_000n }]);
    await worker.tick();
    expect(await repos.deposits.listByUser(alice.id, 10)).toHaveLength(0);
    chain.mine(2);
    await worker.tick();
    expect(await repos.deposits.listByUser(alice.id, 10)).toHaveLength(1);
  });

  it('finds a new user\'s deposits from the next pass on', async () => {
    const { repos, chain, worker } = await setup();
    await worker.tick();
    const bob = await repos.users.upsertByWallet(STRANGER);
    chain.send(USDC, [{ to: bob.walletAddress, value: 2_000_000n }]);
    await worker.tick();
    expect(await repos.deposits.listByUser(bob.id, 10)).toHaveLength(1);
  });
});

describe('onramp worker', () => {
  it('expires orders nobody paid for, and keeps going after one fails', async () => {
    const repos = createMemoryRepositories();
    const chain = new FakeTokenChain();
    let clock = Date.now();
    const provider = {
      name: 'moonpay',
      checkoutUrl: () => '',
      findByOrderId: async (id: string) => {
        if (id === 'order_1') throw new Error('boom');
        return null;
      },
    };
    const tracker = new OnrampTracker({ orders: repos.onrampOrders, provider, reader: chain, token: USDC, confirmations: 0, recheckMs: 0, now: () => new Date(clock) });
    const worker = new OnrampWorker({ orders: repos.onrampOrders, tracker, pollMs: 60_000, recheckMs: 0, now: () => new Date(clock) });
    for (let i = 0; i < 2; i++) {
      await repos.onrampOrders.create({
        userId: 'u1',
        provider: 'moonpay',
        walletAddress: ANVIL.accounts.payer.address,
        fiat: { currency: 'THB', minor: 800_00n },
        expiresAt: new Date(clock + 60_000),
      });
    }
    clock += 120_000;
    await worker.tick();
    expect(repos.state.onrampOrders.get('order_1')).toMatchObject({ status: 'CREATED', lastError: 'Partner unreachable: boom' });
    expect(repos.state.onrampOrders.get('order_2')?.status).toBe('EXPIRED');
  });
});
