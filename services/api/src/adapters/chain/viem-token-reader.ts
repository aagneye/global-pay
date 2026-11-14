import {
  type Address,
  type Hex,
  type PublicClient,
  TransactionReceiptNotFoundError,
  createPublicClient,
  defineChain,
  erc20Abi,
  http,
  parseEventLogs,
} from 'viem';
import type { TokenReader, TokenTransfer } from '../../ports/token-reader.js';
import { AppError } from '../../shared/errors.js';

const TRANSFER = erc20Abi.find((item) => item.type === 'event' && item.name === 'Transfer')!;
/** Recipients per log query: providers cap the topic list. */
const RECIPIENTS_PER_QUERY = 100;

/** TokenReader over a public RPC. Read failures become `chain_unavailable` (503). */
export class ViemTokenReader implements TokenReader {
  readonly chainId: number;
  private readonly client: PublicClient;

  constructor(options: { rpcUrl: string; chainId: number }) {
    this.chainId = options.chainId;
    this.client = createPublicClient({
      chain: defineChain({
        id: options.chainId,
        name: `chain-${options.chainId}`,
        nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
        rpcUrls: { default: { http: [options.rpcUrl] } },
      }),
      transport: http(options.rpcUrl),
    });
  }

  async getLatestBlock(): Promise<bigint> {
    return this.read(() => this.client.getBlockNumber());
  }

  async getTransfersInTx(token: Address, txHash: Hex) {
    let receipt;
    try {
      receipt = await this.client.getTransactionReceipt({ hash: txHash });
    } catch (error) {
      if (error instanceof TransactionReceiptNotFoundError) return null;
      throw unavailable(error);
    }
    const logs = parseEventLogs({ abi: [TRANSFER], logs: receipt.logs, eventName: 'Transfer' }).filter(
      (log) => log.address.toLowerCase() === token.toLowerCase(),
    );
    return {
      status: receipt.status,
      blockNumber: receipt.blockNumber,
      transfers: logs.map((log) => toTransfer(log, receipt.blockNumber)),
    };
  }

  async getTransfersTo(token: Address, recipients: readonly Address[], fromBlock: bigint, toBlock: bigint): Promise<TokenTransfer[]> {
    const transfers: TokenTransfer[] = [];
    for (let i = 0; i < recipients.length; i += RECIPIENTS_PER_QUERY) {
      const to = recipients.slice(i, i + RECIPIENTS_PER_QUERY);
      const logs = await this.read(() =>
        this.client.getLogs({ address: token, event: TRANSFER, args: { to: [...to] }, fromBlock, toBlock, strict: true }),
      );
      for (const log of logs) transfers.push(toTransfer(log, log.blockNumber));
    }
    return transfers;
  }

  private async read<T>(call: () => Promise<T>): Promise<T> {
    try {
      return await call();
    } catch (error) {
      throw unavailable(error);
    }
  }
}

function toTransfer(
  log: { transactionHash: Hex; logIndex: number; args: { from: Address; to: Address; value: bigint } },
  blockNumber: bigint,
): TokenTransfer {
  return {
    txHash: log.transactionHash.toLowerCase() as Hex,
    logIndex: log.logIndex,
    blockNumber,
    from: log.args.from.toLowerCase() as Address,
    to: log.args.to.toLowerCase() as Address,
    value: log.args.value,
  };
}

function unavailable(error: unknown): AppError {
  return new AppError('chain_unavailable', `Chain read failed: ${(error as Error).message.split('\n')[0]}`, 503);
}
