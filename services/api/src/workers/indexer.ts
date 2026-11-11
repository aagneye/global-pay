import type { FastifyBaseLogger } from 'fastify';
import type { SettlementGateway } from '../ports/settlement-gateway.js';

export interface IndexerDeps {
  gateway: SettlementGateway;
  pollMs: number;
  /** Blocks to wait before treating an event as final. */
  confirmations: number;
}

/**
 * Polls `PaymentReceived` events from a saved block cursor and moves payments
 * SUBMITTED → PAID → PAYOUT_PENDING. Re-processing an event has no effect.
 * On-chain events are the source of truth.
 */
export class IndexerWorker {
  private readonly deps: IndexerDeps;

  constructor(deps: IndexerDeps) {
    this.deps = deps;
  }

  start(log: FastifyBaseLogger): void {
    log.warn({ worker: 'indexer' }, 'indexer is planned for iteration 4; not started');
  }

  async stop(): Promise<void> {}
}
