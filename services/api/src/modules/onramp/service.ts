import { type Hex, getAddress } from 'viem';
import type { OnrampOrder } from '../../domain/onramp.js';
import type { OnrampProvider } from '../../ports/onramp-provider.js';
import type { OnrampOrderRepository, UserRepository } from '../../ports/repositories.js';
import { AppError } from '../../shared/errors.js';
import type { OnrampTracker } from './onramp-tracker.js';

export interface OnrampServiceDeps {
  users: UserRepository;
  orders: OnrampOrderRepository;
  provider: OnrampProvider;
  tracker: OnrampTracker;
  minFiatMinor: bigint;
  maxFiatMinor: bigint;
  ttlMs: number;
  maxOpenOrders: number;
  /** Block explorer of the chain the partner delivers on. */
  explorerUrl: string;
  now?: () => Date;
}

/** An order as the app sees it. Amounts are integer strings in minor units. */
export interface OnrampOrderView {
  id: string;
  status: OnrampOrder['status'];
  provider: string;
  fiatCurrency: string;
  fiatAmount: string;
  /** USDC base units: received once COMPLETED, else what the partner said it will send. */
  tokenAmount?: string;
  transaction?: { hash: Hex; url: string };
  failureReason?: string;
  expiresAt: string;
  createdAt: string;
  updatedAt: string;
}

/** "Add money": orders USDC from the onramp partner, to the signed-in user's own wallet. */
export class OnrampService {
  private readonly deps: OnrampServiceDeps;
  private readonly now: () => Date;

  constructor(deps: OnrampServiceDeps) {
    this.deps = deps;
    this.now = deps.now ?? (() => new Date());
  }

  get provider(): OnrampProvider {
    return this.deps.provider;
  }

  get tracker(): OnrampTracker {
    return this.deps.tracker;
  }

  async create(userId: string, fiatMinor: bigint): Promise<{ order: OnrampOrderView; checkoutUrl: string }> {
    const { users, orders, provider, minFiatMinor, maxFiatMinor } = this.deps;
    const user = await users.findById(userId);
    if (!user) throw new AppError('unauthorized', 'Unknown user; sign in again', 401);
    if (fiatMinor < minFiatMinor) {
      throw new AppError('amount_too_small', `The minimum is ${baht(minFiatMinor)} THB`, 422);
    }
    if (fiatMinor > maxFiatMinor) {
      throw new AppError('amount_too_large', `The maximum is ${baht(maxFiatMinor)} THB`, 422);
    }
    if ((await orders.countOpen(userId)) >= this.deps.maxOpenOrders) {
      throw new AppError('too_many_orders', 'Finish or wait out your open orders first', 429);
    }

    const fiat = { currency: 'THB' as const, minor: fiatMinor };
    const order = await orders.create({
      userId,
      provider: provider.name,
      walletAddress: user.walletAddress,
      fiat,
      expiresAt: new Date(this.now().getTime() + this.deps.ttlMs),
    });
    const checkoutUrl = provider.checkoutUrl({ orderId: order.id, walletAddress: getAddress(user.walletAddress), fiat });
    return { order: this.view(order), checkoutUrl };
  }

  /** The order, refreshed from the partner if it's due (the app asks when it comes back to the foreground). */
  async get(userId: string, orderId: string): Promise<OnrampOrderView> {
    const order = await this.deps.orders.findById(orderId);
    if (!order || order.userId !== userId) throw new AppError('not_found', 'No such order', 404);
    return this.view(await this.deps.tracker.check(order));
  }

  /** Checks an order with the partner now, whoever owns it (the simulator, after "paying"). */
  async refresh(orderId: string): Promise<void> {
    const order = await this.deps.orders.findById(orderId);
    if (order) await this.deps.tracker.check(order, { force: true });
  }

  async list(userId: string): Promise<OnrampOrderView[]> {
    return (await this.deps.orders.listByUser(userId, 20)).map((order) => this.view(order));
  }

  view(order: OnrampOrder): OnrampOrderView {
    const tokenAmount = order.receivedAmount ?? order.expectedTokenAmount;
    return {
      id: order.id,
      status: order.status,
      provider: order.provider,
      fiatCurrency: order.fiat.currency,
      fiatAmount: order.fiat.minor.toString(),
      ...(tokenAmount === undefined ? {} : { tokenAmount: tokenAmount.toString() }),
      ...(order.txHash ? { transaction: { hash: order.txHash, url: `${this.deps.explorerUrl.replace(/\/$/, '')}/tx/${order.txHash}` } } : {}),
      ...(order.failureReason === undefined ? {} : { failureReason: order.failureReason }),
      expiresAt: order.expiresAt.toISOString(),
      createdAt: order.createdAt.toISOString(),
      updatedAt: order.updatedAt.toISOString(),
    };
  }
}

const baht = (minor: bigint) => `${minor / 100n}${minor % 100n ? `.${(minor % 100n).toString().padStart(2, '0')}` : ''}`;
