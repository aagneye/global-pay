import { type Address, type Hex, keccak256, toHex, zeroAddress } from 'viem';
import type { TokenReader, TokenTransfer } from '../../src/ports/token-reader.js';

interface Tx {
  status: 'success' | 'reverted';
  blockNumber: bigint;
  transfers: (TokenTransfer & { token: Address })[];
}

/**
 * An in-memory chain of token transfers, for onramp and deposit tests. Each `send` mines one
 * transaction in a new block; `pending` makes a hash the chain doesn't have yet.
 */
export class FakeTokenChain implements TokenReader {
  block = 1_000n;
  private readonly txs = new Map<Hex, Tx>();
  private count = 0;

  constructor(readonly chainId = 31337) {}

  async getLatestBlock(): Promise<bigint> {
    return this.block;
  }

  /** Mines a transaction with these transfers of `token`; returns its hash. */
  send(token: Address, transfers: { from?: Address; to: Address; value: bigint }[], status: Tx['status'] = 'success'): Hex {
    const hash = this.pending();
    this.block += 1n;
    this.txs.set(hash, {
      status,
      blockNumber: this.block,
      transfers: transfers.map((t, logIndex) => ({
        token: token.toLowerCase() as Address,
        txHash: hash,
        logIndex,
        blockNumber: this.block,
        from: (t.from ?? zeroAddress).toLowerCase() as Address,
        to: t.to.toLowerCase() as Address,
        value: t.value,
      })),
    });
    return hash;
  }

  /** A transaction hash that isn't mined (yet). */
  pending(): Hex {
    return keccak256(toHex(`fake-token-tx-${++this.count}`));
  }

  /** Mines `n` empty blocks. */
  mine(n = 1): void {
    this.block += BigInt(n);
  }

  async getTransfersInTx(token: Address, txHash: Hex) {
    const tx = this.txs.get(txHash.toLowerCase() as Hex);
    if (!tx) return null;
    return {
      status: tx.status,
      blockNumber: tx.blockNumber,
      transfers: tx.transfers.filter((t) => t.token === token.toLowerCase()).map(({ token: _token, ...t }) => t),
    };
  }

  async getTransfersTo(token: Address, recipients: readonly Address[], fromBlock: bigint, toBlock: bigint): Promise<TokenTransfer[]> {
    const to = new Set(recipients.map((r) => r.toLowerCase()));
    return [...this.txs.values()]
      .filter((tx) => tx.status === 'success' && tx.blockNumber >= fromBlock && tx.blockNumber <= toBlock)
      .flatMap((tx) => tx.transfers)
      .filter((t) => t.token === token.toLowerCase() && to.has(t.to))
      .map(({ token: _token, ...t }) => t);
  }
}
