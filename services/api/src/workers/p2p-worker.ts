import type { P2pService } from '../modules/p2p/service.js';
import type { PaymentRequestRepository } from '../ports/repositories.js';
import type { SettlementGateway } from '../ports/settlement-gateway.js';
import { PollingLoop, type WorkerLogger, silentLogger } from './loop.js';

export interface P2pWorkerDeps {
  requests: PaymentRequestRepository;
  gateway: Pick<SettlementGateway, 'getReceipt'>;
  p2p: Pick<P2pService, 'notify'>;
  pollMs: number;
  now?: () => Date;
}

/**
 * Finishes person-to-person requests: expires the ones nobody approved in time, and records relayed
 * transfers once mined (COMPLETED, telling the receiver) or reverted (FAILED). Requests live in the
 * database, so a restart picks up where it left off.
 */
export class P2pWorker {
  private readonly deps: P2pWorkerDeps;
  private readonly loop: PollingLoop;
  private readonly now: () => Date;
  private log: WorkerLogger = silentLogger;

  constructor(deps: P2pWorkerDeps) {
    this.deps = deps;
    this.now = deps.now ?? (() => new Date());
    this.loop = new PollingLoop('p2p', deps.pollMs, () => this.tick());
  }

  start(log: WorkerLogger): void {
    this.log = log;
    this.loop.start(log);
  }

  async stop(): Promise<void> {
    await this.loop.stop();
  }

  async tick(): Promise<void> {
    const { requests, gateway } = this.deps;
    const now = this.now();
    for (const request of await requests.listByStatus(['CREATED', 'SENDER_IDENTIFIED'], 100)) {
      if (now >= request.expiresAt) await requests.transition(request.id, request.status, 'EXPIRED');
    }
    for (const request of await requests.listByStatus(['SUBMITTED'], 100)) {
      try {
        const receipt = request.txHash ? await gateway.getReceipt(request.txHash) : null;
        if (!receipt) continue;
        if (receipt.status === 'success') {
          if (await requests.transition(request.id, 'SUBMITTED', 'COMPLETED')) {
            this.log.info({ requestId: request.id, txHash: request.txHash }, 'p2p payment completed');
            await this.deps.p2p.notify(request.receiverId, {
              title: 'Payment received',
              body: 'Open GlobalPay to see it',
              data: { type: 'p2p_completed', requestId: request.id },
            });
          }
        } else {
          await requests.transition(request.id, 'SUBMITTED', 'FAILED', { failureReason: 'The transfer reverted on-chain' });
        }
      } catch (error) {
        this.log.error({ err: error, requestId: request.id }, 'could not check p2p transfer; will retry');
      }
    }
  }
}
