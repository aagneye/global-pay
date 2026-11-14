import type { OnrampOrder } from '../domain/onramp.js';
import type { OnrampTracker } from '../modules/onramp/onramp-tracker.js';
import type { OnrampOrderRepository } from '../ports/repositories.js';
import { PollingLoop, type WorkerLogger, silentLogger } from './loop.js';

export interface OnrampWorkerDeps {
  orders: OnrampOrderRepository;
  tracker: OnrampTracker;
  pollMs: number;
  batchSize?: number;
}

/**
 * Moves open Add-money orders along: asks the partner (at most every recheck period), checks the chain
 * for the delivering transfer, and expires orders nobody paid for. Webhooks only make this faster.
 */
export class OnrampWorker {
  private readonly deps: OnrampWorkerDeps;
  private readonly loop: PollingLoop;
  private log: WorkerLogger = silentLogger;

  constructor(deps: OnrampWorkerDeps) {
    this.deps = deps;
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
    for (const order of await this.deps.orders.listByStatus(['CREATED', 'PENDING'], this.deps.batchSize ?? 50)) {
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
