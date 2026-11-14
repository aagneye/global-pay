import type { Address, Hex } from 'viem';

/** An ERC-20 `Transfer` event. Addresses are lowercase. */
export interface TokenTransfer {
  txHash: Hex;
  logIndex: number;
  blockNumber: bigint;
  from: Address;
  to: Address;
  value: bigint;
}

/**
 * Reads token transfers from one chain. Used to prove onramp deliveries and to find deposits.
 * Kept apart from SettlementGateway because the onramp may deliver on another chain
 * (MoonPay's sandbox sends test tokens on Ethereum Sepolia).
 */
export interface TokenReader {
  readonly chainId: number;
  getLatestBlock(): Promise<bigint>;
  /** The transaction's transfers of `token`, or null if it isn't in a block yet. */
  getTransfersInTx(
    token: Address,
    txHash: Hex,
  ): Promise<{ status: 'success' | 'reverted'; blockNumber: bigint; transfers: TokenTransfer[] } | null>;
  /** Transfers of `token` to any of `recipients` in the block range (inclusive). */
  getTransfersTo(token: Address, recipients: readonly Address[], fromBlock: bigint, toBlock: bigint): Promise<TokenTransfer[]>;
}
