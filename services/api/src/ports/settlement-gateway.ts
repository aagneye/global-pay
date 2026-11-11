import type { Address, Hex } from 'viem';
import type { ReceiveAuthorization, SignedQuote } from '../domain/quote.js';

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

/** Everything the backend does on-chain, through the GlobalPaySettlement contract. */
export interface SettlementGateway {
  /** Relayer submits `pay()` and pays the gas. Returns the transaction hash. */
  submitPayment(signed: SignedQuote, authorization: ReceiveAuthorization): Promise<Hex>;
  markSettled(quoteId: Hex): Promise<Hex>;
  refund(quoteId: Hex): Promise<Hex>;
  waitForReceipt(txHash: Hex): Promise<TxReceipt>;
  getLatestBlock(): Promise<bigint>;
  getPaymentReceivedEvents(fromBlock: bigint, toBlock: bigint): Promise<PaymentReceivedEvent[]>;
  getTokenBalance(token: Address, owner: Address): Promise<bigint>;
  /** The token's EIP-712 domain. Read from the chain because name/version differ per network. */
  getTokenDomain(token: Address): Promise<{ name: string; version: string }>;
}
