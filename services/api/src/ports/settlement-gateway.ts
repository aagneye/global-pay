import type { Address, Hex } from 'viem';
import type { TransferAuthorization } from '../domain/p2p.js';
import type { ReceiveAuthorization, SignedQuote } from '../domain/quote.js';
import { AppError } from '../shared/errors.js';

/** Decoded `IGlobalPaySettlement.PaymentReceived` event. */
export interface PaymentReceivedEvent {
  quoteId: Hex;
  payer: Address;
  token: Address;
  tokenAmount: bigint;
  /** ISO 4217 alpha code, e.g. "THB" (bytes3 on-chain). */
  fiatCurrency: string;
  fiatAmount: bigint;
  merchantRefHash: Hex;
  txHash: Hex;
  blockNumber: bigint;
  logIndex: number;
}

export interface TxReceipt {
  status: 'success' | 'reverted';
  blockNumber: bigint;
}

/** `IGlobalPaySettlement.PaymentStatus` for a quote. */
export type OnChainPaymentStatus = 'None' | 'Paid' | 'Settled' | 'Refunded';

/**
 * The contract would revert, so nothing was sent. `reason` is the decoded error name or message,
 * e.g. "QuoteExpired" or "ERC20InsufficientBalance".
 */
export class TransactionRejectedError extends AppError {
  readonly reason: string;

  constructor(reason: string) {
    super('transaction_rejected', `The transaction would fail: ${reason}`, 422);
    this.name = 'TransactionRejectedError';
    this.reason = reason;
  }
}

/**
 * The chain couldn't be reached. If `txHash` is set, the transaction was signed and may or may not
 * have reached the network: check its receipt later instead of assuming either way.
 */
export class ChainUnavailableError extends AppError {
  readonly txHash: Hex | undefined;

  constructor(message: string, txHash?: Hex) {
    super('chain_unavailable', message, 503);
    this.name = 'ChainUnavailableError';
    this.txHash = txHash;
  }
}

/**
 * Everything the backend does on-chain, through the GlobalPaySettlement contract.
 * Writes are simulated first: a call that would revert throws TransactionRejectedError and sends nothing.
 */
export interface SettlementGateway {
  /** Relayer submits `pay()` and pays the gas. Returns the transaction hash once the node accepted it. */
  submitPayment(signed: SignedQuote, authorization: ReceiveAuthorization): Promise<Hex>;
  markSettled(quoteId: Hex): Promise<Hex>;
  /** Relayer submits USDC `transferWithAuthorization` (person-to-person) and pays the gas. */
  submitTransfer(authorization: TransferAuthorization): Promise<Hex>;
  refund(quoteId: Hex): Promise<Hex>;
  /** Waits until the transaction is in a block. */
  waitForReceipt(txHash: Hex): Promise<TxReceipt>;
  /** The receipt if the transaction is in a block, otherwise null. */
  getReceipt(txHash: Hex): Promise<TxReceipt | null>;
  getLatestBlock(): Promise<bigint>;
  getPaymentReceivedEvents(fromBlock: bigint, toBlock: bigint): Promise<PaymentReceivedEvent[]>;
  getPaymentStatus(quoteId: Hex): Promise<OnChainPaymentStatus>;
  getTokenBalance(token: Address, owner: Address): Promise<bigint>;
  /** The relayer's address and ETH balance (wei), for the low-gas alert; null without a relayer key. */
  getRelayerBalance(): Promise<{ address: Address; wei: bigint } | null>;
  /** The token's EIP-712 domain. Read from the chain because name/version differ per network. */
  getTokenDomain(token: Address): Promise<{ name: string; version: string }>;
}
