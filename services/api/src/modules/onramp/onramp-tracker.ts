import type { Address } from 'viem';
import type { OnrampOrder, OnrampStatus } from '../../domain/onramp.js';
import type { OnrampProvider, OnrampResult, OnrampWebhookRef } from '../../ports/onramp-provider.js';
import type { OnrampFields, OnrampOrderRepository } from '../../ports/repositories.js';
import type { TokenReader } from '../../ports/token-reader.js';
import { AppError } from '../../shared/errors.js';

export interface OnrampTrackerDeps {
  orders: OnrampOrderRepository;
  provider: OnrampProvider;
  /** The chain the partner delivers on, and its token. */
  reader: TokenReader;
  token: Address;
  /** Blocks to wait after the delivering transfer's block. */
  confirmations: number;
  /** How often to ask the partner about an open order. */
  recheckMs: number;
  now?: () => Date;
}

/**
 * Keeps each Add-money order in line with the partner and the chain (ADR 0009). Used by the onramp
 * worker, the partner webhook and the order routes, so all apply answers the same way.
 *
 * - The partner is asked for the purchase by our order ID; webhooks only trigger that.
 * - "completed" from the partner only means PENDING. COMPLETED needs a confirmed transfer of the token to
 *   the order's wallet, for the amount the partner reported, and each transfer completes one order.
 * - A partner sending to another wallet never completes the order.
 * - A partner or chain that can't be reached changes nothing; the error is kept on the order.
 */
export class OnrampTracker {
  private readonly deps: OnrampTrackerDeps;
  private readonly now: () => Date;

  constructor(deps: OnrampTrackerDeps) {
    this.deps = deps;
    this.now = deps.now ?? (() => new Date());
  }

  get providerName(): string {
    return this.deps.provider.name;
  }

  /** Asks the partner (unless asked recently), applies the answer, then checks the chain if it can. */
  async check(order: OnrampOrder, options: { force?: boolean } = {}): Promise<OnrampOrder> {
    if (order.status === 'COMPLETED' || order.status === 'FAILED') return order;
    if (order.provider !== this.deps.provider.name) return order;
    const now = this.now();
    const due = !order.lastCheckedAt || now.getTime() - order.lastCheckedAt.getTime() >= this.deps.recheckMs;
    if (!options.force && !due) return order;

    let result: OnrampResult | null;
    try {
      result = await this.deps.provider.findByOrderId(order.id);
    } catch (error) {
      return this.deps.orders.update(order.id, { lastError: `Partner unreachable: ${(error as Error).message}`, lastCheckedAt: now });
    }
    if (!result) return this.deps.orders.update(order.id, { lastCheckedAt: now });
    return this.apply(order, result);
  }

  /**
   * A CREATED order past its expiry, still unpaid at the partner (or unknown there), becomes EXPIRED.
   * If the user pays after all, the partner's answer moves it on from EXPIRED.
   */
  async expireIfDue(order: OnrampOrder): Promise<OnrampOrder> {
    if (order.status !== 'CREATED' || this.now() < order.expiresAt) return order;
    let result: OnrampResult | null;
    try {
      result = await this.deps.provider.findByOrderId(order.id);
    } catch (error) {
      // Can't tell whether the user paid: don't expire yet.
      return this.deps.orders.update(order.id, { lastError: `Partner unreachable: ${(error as Error).message}`, lastCheckedAt: this.now() });
    }
    if (result) {
      const fresh = await this.apply(order, result);
      if (fresh.status !== 'CREATED' || result.status !== 'waiting') return fresh;
    }
    await this.deps.orders.transition(order.id, 'CREATED', 'EXPIRED', { lastError: null });
    return this.reload(order);
  }

  /** A webhook arrived: look the order up and ask the partner (an expired order may have come back). */
  async onWebhook(ref: OnrampWebhookRef): Promise<'applied' | 'ignored'> {
    const order = ref.orderId ? await this.deps.orders.findById(ref.orderId) : null;
    if (!order || order.provider !== this.deps.provider.name) return 'ignored';
    await this.check(order, { force: true });
    return 'applied';
  }

  async apply(order: OnrampOrder, result: OnrampResult): Promise<OnrampOrder> {
    const { orders } = this.deps;
    const seen: OnrampFields = {
      providerTxId: result.providerTxId,
      providerStatus: result.providerStatus,
      lastCheckedAt: this.now(),
      lastError: null,
      ...(result.tokenAmount === undefined ? {} : { expectedTokenAmount: result.tokenAmount }),
      ...(result.txHash ? { txHash: result.txHash } : {}),
    };
    if (result.walletAddress && result.walletAddress.toLowerCase() !== order.walletAddress.toLowerCase()) {
      return orders.update(order.id, { lastError: `Partner is sending to ${result.walletAddress}, not the order's wallet`, lastCheckedAt: this.now() });
    }

    switch (result.status) {
      case 'waiting':
        await orders.update(order.id, seen);
        return this.reload(order);
      case 'failed':
        await this.move(order, 'FAILED', { ...seen, failureReason: result.failureReason ?? 'The purchase failed' });
        return this.reload(order);
      case 'pending':
      case 'completed': {
        await this.move(order, 'PENDING', seen);
        const pending = await this.reload(order);
        return result.status === 'completed' && pending.txHash ? this.verify(pending) : pending;
      }
    }
  }

  /** Completes the order once its delivering transfer is confirmed on-chain. */
  async verify(order: OnrampOrder): Promise<OnrampOrder> {
    const { reader, token, orders, confirmations } = this.deps;
    if (!order.txHash || (order.status !== 'PENDING' && order.status !== 'CREATED' && order.status !== 'EXPIRED')) return order;
    const note = (lastError: string) => orders.update(order.id, { lastError });

    let tx;
    let latest;
    try {
      [tx, latest] = await Promise.all([reader.getTransfersInTx(token, order.txHash), reader.getLatestBlock()]);
    } catch (error) {
      return note(`Chain unreachable: ${(error as Error).message}`);
    }
    if (!tx) return note('Waiting for the delivery transaction to be mined');
    if (tx.status === 'reverted') return note('The delivery transaction reverted');
    if (tx.blockNumber > latest - BigInt(confirmations)) return note('Waiting for confirmations');

    const wallet = order.walletAddress.toLowerCase();
    const transfer = tx.transfers.find(
      (t) => t.to === wallet && (order.expectedTokenAmount === undefined || t.value === order.expectedTokenAmount),
    );
    if (!transfer) return note("The delivery transaction has no transfer of the expected amount to the user's wallet");

    try {
      await orders.transition(order.id, order.status, 'COMPLETED', {
        txHash: transfer.txHash,
        logIndex: transfer.logIndex,
        receivedAmount: transfer.value,
        lastError: null,
      });
    } catch (error) {
      if (error instanceof AppError && error.code === 'transfer_already_counted') return note(error.message);
      throw error;
    }
    return this.reload(order);
  }

  /** Moves to `to` if allowed from the current status; otherwise just records what was seen. */
  private async move(order: OnrampOrder, to: OnrampStatus, fields: OnrampFields): Promise<void> {
    const allowed: Record<OnrampStatus, OnrampStatus[]> = {
      CREATED: ['PENDING', 'FAILED'],
      EXPIRED: ['PENDING', 'FAILED'],
      PENDING: ['FAILED'],
      COMPLETED: [],
      FAILED: [],
    };
    if (allowed[order.status].includes(to) && (await this.deps.orders.transition(order.id, order.status, to, fields))) return;
    await this.deps.orders.update(order.id, fields);
  }

  private async reload(order: OnrampOrder): Promise<OnrampOrder> {
    return (await this.deps.orders.findById(order.id)) ?? order;
  }
}
