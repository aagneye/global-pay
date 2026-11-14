import type { P2pService } from '../modules/p2p/service.js';
import type { PaymentRequestRepository } from '../ports/repositories.js';
import type { SettlementGateway } from '../ports/settlement-gateway.js';
import { PollingLoop, type WorkerLogger, silentLogger } from './loop.js';

export interface P2pWorkerDeps {
  requests: PaymentRequestRepository;
  gateway: Pick<SettlementGateway, 'getReceipt'>;
  p2p: Pick<P2pService, 'notify'>;
  pollMs: number;
  /** An APPROVING request with nothing sent is handed back after this long (the approval was abandoned). */
  approvingTimeoutMs?: number;
  now?: () => Date;
}

/**
 * Finishes person-to-person requests: expires the ones nobody approved in time, and records relayed
 * transfers once mined (COMPLETED, telling the receiver) or reverted (FAILED). Requests live in the
 * database, so a restart picks up where it left off.
 *
 * An APPROVING request with a transfer hash is treated like SUBMITTED: its receipt decides. One without
 * a hash has had nothing sent (hashes are stored before broadcasting); once it has sat for
 * `approvingTimeoutMs` (say the API crashed mid-approval), it goes back to SENDER_IDENTIFIED, or EXPIRED
 * if it's too late to approve. Both moves require that no hash was stored meanwhile.
 */
export class P2pWorker {
  private readonly deps: P2pWorkerDeps;
  private readonly loop: PollingLoop;
  private readonly now: () => Date;
  private readonly approvingTimeoutMs: number;
  private log: WorkerLogger = silentLogger;

  constructor(deps: P2pWorkerDeps) {
    this.deps = deps;
    this.now = deps.now ?? (() => new Date());
    this.approvingTimeoutMs = deps.approvingTimeoutMs ?? 2 * 60_000;
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
    for (const request of await requests.listByStatus(['APPROVING', 'SUBMITTED'], 100)) {
      try {
        if (!request.txHash) {
          if (request.status === 'APPROVING' && now.getTime() - request.updatedAt.getTime() >= this.approvingTimeoutMs) {
            const to = now >= request.expiresAt ? 'EXPIRED' : 'SENDER_IDENTIFIED';
            if (await requests.transitionIfUnsent(request.id, 'APPROVING', to)) {
              this.log.warn({ requestId: request.id, to }, 'p2p approval abandoned before anything was sent');
            }
          }
          continue;
        }
        const receipt = await gateway.getReceipt(request.txHash);
        if (!receipt) continue;
        if (receipt.status === 'success') {
          if (await requests.transition(request.id, request.status, 'COMPLETED')) {
            this.log.info({ requestId: request.id, txHash: request.txHash }, 'p2p payment completed');
            await this.deps.p2p.notify(request.receiverId, {
              title: 'Payment received',
              body: 'Open GlobalPay to see it',
              data: { type: 'p2p_completed', requestId: request.id },
            });
          }
        } else {
          await requests.transition(request.id, request.status, 'FAILED', { failureReason: 'The transfer reverted on-chain' });
        }
      } catch (error) {
        this.log.error({ err: error, requestId: request.id }, 'could not check p2p transfer; will retry');
      }
    }
  }
}
