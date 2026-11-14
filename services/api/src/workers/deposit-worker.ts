import type { Address } from 'viem';
import type { CursorRepository, DepositRepository, UserRepository } from '../ports/repositories.js';
import type { TokenReader } from '../ports/token-reader.js';
import { PollingLoop, type WorkerLogger, silentLogger } from './loop.js';

export interface DepositWorkerDeps {
  users: UserRepository;
  deposits: DepositRepository;
  cursors: CursorRepository;
  reader: TokenReader;
  token: Address;
  /** Senders whose transfers aren't deposits: the settlement contract (refunds show as payments). */
  ignoreFrom: readonly Address[];
  startBlock: bigint;
  confirmations: number;
  maxBlockRange: bigint;
  pollMs: number;
}

/**
 * Finds USDC that arrives in users' wallets from outside (another wallet, an exchange, the onramp) and
 * records it as deposits for their history. Each transfer is stored once; a saved block cursor lets it
 * resume after a restart. A user's transfers from before they signed up aren't looked for.
 */
export class DepositWorker {
  private readonly deps: DepositWorkerDeps;
  private readonly loop: PollingLoop;
  private readonly ignore: Set<string>;
  private log: WorkerLogger = silentLogger;

  constructor(deps: DepositWorkerDeps) {
    this.deps = deps;
    this.ignore = new Set(deps.ignoreFrom.map((a) => a.toLowerCase()));
    this.loop = new PollingLoop('deposits', deps.pollMs, () => this.tick());
  }

  start(log: WorkerLogger): void {
    this.log = log;
    this.loop.start(log);
  }

  async stop(): Promise<void> {
    await this.loop.stop();
  }

  private get cursorId(): string {
    return `deposits:${this.deps.reader.chainId}:${this.deps.token.toLowerCase()}`;
  }

  async tick(): Promise<void> {
    const { reader, cursors, users, deposits, token, maxBlockRange } = this.deps;
    const safeBlock = (await reader.getLatestBlock()) - BigInt(this.deps.confirmations);
    let from = ((await cursors.get(this.cursorId)) ?? this.deps.startBlock - 1n) + 1n;
    if (from > safeBlock) return;

    const owners = new Map((await users.listWallets()).map((u) => [u.walletAddress.toLowerCase(), u.id]));
    const recipients = [...owners.keys()] as Address[];
    while (from <= safeBlock) {
      const to = from + maxBlockRange - 1n < safeBlock ? from + maxBlockRange - 1n : safeBlock;
      if (recipients.length > 0) {
        for (const transfer of await reader.getTransfersTo(token, recipients, from, to)) {
          const userId = owners.get(transfer.to);
          if (!userId || this.ignore.has(transfer.from)) continue;
          const stored = await deposits.record({
            userId,
            chainId: reader.chainId,
            token,
            txHash: transfer.txHash,
            logIndex: transfer.logIndex,
            from: transfer.from,
            amount: transfer.value,
            blockNumber: transfer.blockNumber,
          });
          if (stored) this.log.info({ userId, txHash: transfer.txHash, amount: transfer.value.toString() }, 'deposit received');
        }
      }
      await cursors.set(this.cursorId, to);
      from = to + 1n;
    }
  }
}
