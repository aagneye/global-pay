import { type Address, type Hex, keccak256, toHex } from 'viem';
import type { ReceiveAuthorization, SignedQuote } from '../../src/domain/quote.js';
import {
  ChainUnavailableError,
  type OnChainPaymentStatus,
  type PaymentReceivedEvent,
  type SettlementGateway,
  TransactionRejectedError,
  type TxReceipt,
} from '../../src/ports/settlement-gateway.js';

interface OnChainPayment {
  status: OnChainPaymentStatus;
  payer: Address;
  tokenAmount: bigint;
}

/**
 * An in-memory GlobalPaySettlement, for unit tests of the services and workers.
 * Each transaction is mined into its own block straight away, unless `autoMine` is off;
 * then it waits for `mine()`.
 */
export class FakeChain implements SettlementGateway {
  block = 100n;
  autoMine = true;
  readonly onChain = new Map<string, OnChainPayment>();
  readonly events: PaymentReceivedEvent[] = [];
  readonly receipts = new Map<Hex, TxReceipt>();
  readonly sent: { functionName: 'pay' | 'markSettled' | 'refund'; quoteId: Hex; hash: Hex }[] = [];
  readonly balances = new Map<string, bigint>();
  /** The next write throws this instead of sending. */
  failNextWrite?: Error;
  /** The next write is sent but reverts when mined. */
  revertNextWrite = false;
  private pending: (() => void)[] = [];
  private txCount = 0;

  async submitPayment({ quote }: SignedQuote, _authorization: ReceiveAuthorization): Promise<Hex> {
    return this.write('pay', quote.quoteId, () => {
      const id = quote.quoteId.toLowerCase();
      if (this.onChain.has(id)) return 'QuoteAlreadyUsed';
      if (Date.now() >= quote.expiresAt.getTime()) return 'QuoteExpired';
      return null;
    }, (hash) => {
      this.onChain.set(quote.quoteId.toLowerCase(), {
        status: 'Paid',
        payer: quote.payer,
        tokenAmount: quote.tokenAmount,
      });
      this.events.push({
        quoteId: quote.quoteId,
        payer: quote.payer,
        token: quote.token,
        tokenAmount: quote.tokenAmount,
        fiatCurrency: quote.fiat.currency,
        fiatAmount: quote.fiat.minor,
        merchantRefHash: quote.merchantRefHash,
        txHash: hash,
        blockNumber: this.block,
        logIndex: 0,
      });
    });
  }

  async markSettled(quoteId: Hex): Promise<Hex> {
    return this.resolve('markSettled', quoteId, 'Settled');
  }

  async refund(quoteId: Hex): Promise<Hex> {
    return this.resolve('refund', quoteId, 'Refunded');
  }

  async waitForReceipt(txHash: Hex): Promise<TxReceipt> {
    const receipt = this.receipts.get(txHash);
    if (!receipt) throw new ChainUnavailableError(`timed out waiting for ${txHash}`);
    return receipt;
  }

  async getReceipt(txHash: Hex): Promise<TxReceipt | null> {
    return this.receipts.get(txHash) ?? null;
  }

  async getLatestBlock(): Promise<bigint> {
    return this.block;
  }

  async getPaymentReceivedEvents(fromBlock: bigint, toBlock: bigint): Promise<PaymentReceivedEvent[]> {
    return this.events.filter((e) => e.blockNumber >= fromBlock && e.blockNumber <= toBlock);
  }

  async getPaymentStatus(quoteId: Hex): Promise<OnChainPaymentStatus> {
    return this.onChain.get(quoteId.toLowerCase())?.status ?? 'None';
  }

  async getTokenBalance(_token: Address, owner: Address): Promise<bigint> {
    return this.balances.get(owner.toLowerCase()) ?? 0n;
  }

  /** The relayer's ETH, in wei; null to act as if there's no relayer key. */
  relayerWei: bigint | null = 10n ** 18n;

  async getRelayerBalance(): Promise<{ address: Address; wei: bigint } | null> {
    if (this.relayerWei === null) return null;
    return { address: '0x00000000000000000000000000000000000000aa', wei: this.relayerWei };
  }

  async getTokenDomain(): Promise<{ name: string; version: string }> {
    return { name: 'USDC', version: '2' };
  }

  /** Mines the transactions waiting while `autoMine` is off. */
  mine(): void {
    const pending = this.pending;
    this.pending = [];
    for (const apply of pending) apply();
  }

  /** Adds empty blocks, e.g. to reach a confirmation depth. */
  advance(blocks: bigint): void {
    this.block += blocks;
  }

  private resolve(functionName: 'markSettled' | 'refund', quoteId: Hex, to: OnChainPaymentStatus): Promise<Hex> {
    return this.write(functionName, quoteId, () => {
      const payment = this.onChain.get(quoteId.toLowerCase());
      return payment?.status === 'Paid' ? null : 'InvalidPaymentStatus';
    }, () => {
      const payment = this.onChain.get(quoteId.toLowerCase());
      if (payment) payment.status = to;
    });
  }

  private async write(
    functionName: 'pay' | 'markSettled' | 'refund',
    quoteId: Hex,
    check: () => string | null,
    effect: (hash: Hex) => void,
  ): Promise<Hex> {
    if (this.failNextWrite) {
      const error = this.failNextWrite;
      this.failNextWrite = undefined;
      throw error;
    }
    const rejection = check();
    if (rejection) throw new TransactionRejectedError(rejection);

    const hash = keccak256(toHex(`tx-${++this.txCount}`));
    this.sent.push({ functionName, quoteId, hash });
    const reverts = this.revertNextWrite;
    this.revertNextWrite = false;
    const apply = () => {
      this.block += 1n;
      if (!reverts) effect(hash);
      this.receipts.set(hash, { status: reverts ? 'reverted' : 'success', blockNumber: this.block });
    };
    if (this.autoMine) apply();
    else this.pending.push(apply);
    return hash;
  }
}
