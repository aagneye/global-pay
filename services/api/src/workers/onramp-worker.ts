import type { OnrampOrder } from '../domain/onramp.js';
import type { OnrampTracker } from '../modules/onramp/onramp-tracker.js';
import type { OnrampOrderRepository } from '../ports/repositories.js';
import { PollingLoop, type WorkerLogger, silentLogger } from './loop.js';
import { RoundRobin } from './paging.js';

const MINUTE = 60_000;

export interface OnrampWorkerDeps {
  orders: OnrampOrderRepository;
  tracker: OnrampTracker;
  pollMs: number;
  /** How often to ask the partner about an open order (the tracker's ONRAMP_RECHECK_MS). */
  recheckMs: number;
  batchSize?: number;
  /** How often to ask about an EXPIRED order... */
  expiredRecheckMs?: number;
  /** ...and for how long after it was created (ADR 0009: a late payment still completes it). */
  expiredWindowMs?: number;
  now?: () => Date;
}

const key = (order: OnrampOrder) => ({ createdAt: order.createdAt, id: order.id });

/**
 * Moves Add-money orders along: asks the partner (at most every recheck period), checks the chain
 * for the delivering transfer, and expires orders nobody paid for. Webhooks only make this faster.
 *
 * Expired orders are asked about too, less often and for a day, so a payment that turns up late still
 * completes its order. Only orders due a check are taken, a page at a time, continuing where the last
 * tick stopped: orders that can't finish (say, the partner is sending to another wallet) never keep newer
 * ones waiting.
 */
export class OnrampWorker {
  private readonly deps: OnrampWorkerDeps;
  private readonly loop: PollingLoop;
  private readonly now: () => Date;
  private readonly open = new RoundRobin(key);
  private readonly expired = new RoundRobin(key);
  private log: WorkerLogger = silentLogger;

  constructor(deps: OnrampWorkerDeps) {
    this.deps = deps;
    this.now = deps.now ?? (() => new Date());
    this.loop = new PollingLoop('onramp', deps.pollMs, () => this.tick());
  }

  start(log: WorkerLogger): void {
    this.log = log;
    this.loop.start(log);
  }

  async stop(): Promise<void> {
    await this.loop.stop();
  }

  async tick(): Promise<void> {
    const { orders, recheckMs } = this.deps;
    const limit = this.deps.batchSize ?? 50;
    const now = this.now().getTime();
    const open = await this.open.next(limit, (after) =>
      orders.listDue({ statuses: ['CREATED', 'PENDING'], checkedBefore: new Date(now - recheckMs), ...(after ? { after } : {}) }, limit),
    );
    const expired = await this.expired.next(limit, (after) =>
      orders.listDue(
        {
          statuses: ['EXPIRED'],
          checkedBefore: new Date(now - (this.deps.expiredRecheckMs ?? 5 * MINUTE)),
          createdAfter: new Date(now - (this.deps.expiredWindowMs ?? 24 * 60 * MINUTE)),
          ...(after ? { after } : {}),
        },
        limit,
      ),
    );
    for (const order of [...open, ...expired]) {
      try {
        await this.advance(order);
      } catch (error) {
        this.log.error({ err: error, orderId: order.id }, 'onramp step failed; will retry');
      }
    }
  }

  private async advance(order: OnrampOrder): Promise<void> {
    const { tracker } = this.deps;
    let current = await tracker.check(order);
    if (current.status === 'PENDING' && current.txHash) current = await tracker.verify(current);
    current = await tracker.expireIfDue(current);
    if (current.status !== order.status) {
      this.log.info({ orderId: order.id, from: order.status, to: current.status }, 'onramp order moved');
    }
  }
}
