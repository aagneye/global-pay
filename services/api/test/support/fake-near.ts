import { randomBytes } from 'node:crypto';
import { baseEncode, decodeSignedDelegate } from 'near-api-js';
import type { Address, Hex } from 'viem';
import type { PaymentAuthorization, SignedQuote } from '../../src/domain/quote.js';
import type { NearGateway } from '../../src/ports/near-chain.js';
import {
  ChainUnavailableError,
  type OnChainPaymentStatus,
  type PaymentReceivedEvent,
  TransactionRejectedError,
  type TxReceipt,
} from '../../src/ports/settlement-gateway.js';
import { AppError } from '../../src/shared/errors.js';

interface Paid {
  event: PaymentReceivedEvent;
  status: OnChainPaymentStatus;
}

/**
 * An in-memory NEAR settlement contract and relayer, for service tests of the NEAR rail.
 * Like NearSettlementGateway, "block" n is the payment with index n - 1, and getLatestBlock() is paid_count.
 * Transactions land at once with base58 hashes; events know their hash only while `rememberHashes` is on.
 */
export class FakeNearGateway implements NearGateway {
  finalHeight = 200_000_000n;
  /** Access key nonces by "account:publicKey". Missing: the account doesn't exist. */
  readonly accessKeys = new Map<string, bigint>();
  readonly balances = new Map<string, bigint>();
  readonly paid: Paid[] = [];
  readonly receipts = new Map<string, TxReceipt>();
  readonly sent: { kind: 'delegate' | 'settle' | 'refund'; quoteId: Hex; hash: Hex; receiverId: string }[] = [];
  /** The next write throws this instead of sending. */
  failNextWrite?: Error;
  /** Like a restarted process: events don't carry the relayed transaction's hash. */
  rememberHashes = true;
  relayerYocto = 10n ** 24n;

  setAccessKey(accountId: string, publicKey: string, nonce: bigint): void {
    this.accessKeys.set(`${accountId}:${publicKey}`, nonce);
  }

  async getAccessKeyNonce(accountId: string, publicKey: string): Promise<bigint | null> {
    return this.accessKeys.get(`${accountId}:${publicKey}`) ?? null;
  }

  async getFinalBlockHeight(): Promise<bigint> {
    return this.finalHeight;
  }

  /** Relays the delegate: the user's ft_transfer_call lands and the contract records the payment. */
  async submitPayment({ quote }: SignedQuote, authorization: PaymentAuthorization): Promise<Hex> {
    if (authorization.kind !== 'near-delegate') throw new AppError('invalid_authorization', 'expected a signed delegate', 422);
    const { delegateAction } = decodeSignedDelegate(Buffer.from(authorization.signedDelegate, 'base64'));
    return this.write('delegate', quote.quoteId, delegateAction.senderId, () => {
      if (this.paid.some((p) => p.event.quoteId === quote.quoteId)) return 'quote already used';
      return null;
    }, (hash) => {
      this.paid.push({
        status: 'Paid',
        event: {
          quoteId: quote.quoteId,
          payer: quote.payer,
          token: quote.token,
          tokenAmount: quote.tokenAmount,
          fiatCurrency: quote.fiat.currency,
          fiatAmount: quote.fiat.minor,
          merchantRefHash: quote.merchantRefHash,
          txHash: hash,
          blockNumber: this.finalHeight,
          logIndex: this.paid.length,
        },
      });
    });
  }

  markSettled(quoteId: Hex): Promise<Hex> {
    return this.resolve('settle', quoteId, 'Settled');
  }

  refund(quoteId: Hex): Promise<Hex> {
    return this.resolve('refund', quoteId, 'Refunded');
  }

  async submitTransfer(): Promise<Hex> {
    throw new AppError('not_configured', 'Tap to pay is not available on the NEAR rail', 503);
  }

  async getTokenDomain(): Promise<{ name: string; version: string }> {
    throw new AppError('not_configured', 'no EIP-712 domains on NEAR', 503);
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
    return BigInt(this.paid.length);
  }

  async getPaymentReceivedEvents(fromBlock: bigint, toBlock: bigint): Promise<PaymentReceivedEvent[]> {
    return this.paid
      .filter((_p, index) => BigInt(index + 1) >= fromBlock && BigInt(index + 1) <= toBlock)
      .map(({ event }) => {
        if (this.rememberHashes) return event;
        const { txHash: _hash, ...rest } = event;
        return rest;
      });
  }

  async getPaymentStatus(quoteId: Hex): Promise<OnChainPaymentStatus> {
    return this.paid.find((p) => p.event.quoteId === quoteId)?.status ?? 'None';
  }

  async getTokenBalance(_token: Address, owner: Address): Promise<bigint> {
    return this.balances.get(owner) ?? 0n;
  }

  async getRelayerBalance(): Promise<{ address: Address; wei: bigint }> {
    return { address: 'gp-test01-relayer.testnet' as Address, wei: this.relayerYocto };
  }

  private resolve(kind: 'settle' | 'refund', quoteId: Hex, to: OnChainPaymentStatus): Promise<Hex> {
    return this.write(kind, quoteId, 'gp-test01-settle.testnet', () => {
      return this.paid.find((p) => p.event.quoteId === quoteId)?.status === 'Paid' ? null : 'InvalidPaymentStatus';
    }, () => {
      const payment = this.paid.find((p) => p.event.quoteId === quoteId);
      if (payment) payment.status = to;
    });
  }

  private async write(
    kind: 'delegate' | 'settle' | 'refund',
    quoteId: Hex,
    receiverId: string,
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
    // A NEAR transaction hash: base58 of 32 bytes, mixed case.
    const hash = baseEncode(randomBytes(32)) as Hex;
    this.sent.push({ kind, quoteId, hash, receiverId });
    this.finalHeight += 1n;
    effect(hash);
    this.receipts.set(hash, { status: 'success', blockNumber: this.finalHeight });
    return hash;
  }
}

/** Records onboarding calls instead of sending testnet transactions. */
export class RecordingOnboarding {
  readonly accounts: string[] = [];

  async onboard(accountId: string): Promise<void> {
    this.accounts.push(accountId);
  }
}
