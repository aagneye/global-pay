import type { FastifyBaseLogger } from 'fastify';
import type { PayoutProvider } from '../ports/payout-provider.js';
import type { SettlementGateway } from '../ports/settlement-gateway.js';

export interface PayoutWorkerDeps {
  payouts: PayoutProvider;
  gateway: SettlementGateway;
  pollMs: number;
}

/**
 * For each PAYOUT_PENDING payment: asks the partner to pay the merchant in THB, then calls
 * `markSettled` on success or `refund` on failure, and records the result.
 */
export class PayoutWorker {
  private readonly deps: PayoutWorkerDeps;

  constructor(deps: PayoutWorkerDeps) {
    this.deps = deps;
  }

  start(log: FastifyBaseLogger): void {
    log.warn({ worker: 'payouts' }, 'payout worker is planned for iteration 4; not started');
  }

  async stop(): Promise<void> {}
}
