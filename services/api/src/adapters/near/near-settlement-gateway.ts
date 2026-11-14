import {
  type Action,
  KeyPairSigner,
  type KeyPairString,
  type PublicKey,
  actions,
  baseDecode,
  baseEncode,
  createTransaction,
  decodeSignedDelegate,
} from 'near-api-js';
import type { Address, Hex } from 'viem';
import type { PaymentAuthorization, SignedQuote } from '../../domain/quote.js';
import type { NearGateway } from '../../ports/near-chain.js';
import {
  ChainUnavailableError,
  type OnChainPaymentStatus,
  type PaymentReceivedEvent,
  TransactionRejectedError,
  type TxReceipt,
} from '../../ports/settlement-gateway.js';
import { AppError } from '../../shared/errors.js';
import { decodeBase64, encodeBase64 } from './keys.js';
import { type FinalExecutionOutcome, NearRpc, NearRpcError, NearRpcUnavailableError } from './rpc.js';

/** Gas for operator calls (settle, refund): each makes an ft_transfer with a callback. */
export const OPERATOR_CALL_GAS = 100_000_000_000_000n;

/**
 * A payment as the settlement contract's views return it (contracts-near `PaymentView`).
 * Numbers may come as JSON numbers (u64) or strings (U64/U128); both are accepted.
 */
export interface NearPaymentView {
  quote_id: string;
  payer: string;
  token: string;
  token_amount: string;
  fiat_currency: string;
  fiat_amount: string;
  merchant_ref_hash: string;
  status: string;
  paid_block: number | string;
  index: number | string;
}

const STATUSES: Record<string, OnChainPaymentStatus> = { Paid: 'Paid', Settled: 'Settled', Refunded: 'Refunded' };

export interface NearSettlementGatewayOptions {
  rpcUrl: string;
  settlementContract: string;
  relayerAccountId?: string;
  /** "ed25519:..." full-access key of the relayer, which is also the contract's operator. */
  relayerPrivateKey?: string;
  /** How often to ask for a transaction's outcome while waiting. */
  pollingIntervalMs?: number;
  receiptTimeoutMs?: number;
  /** Overrides fetch (tests). */
  fetch?: typeof fetch;
}

/**
 * SettlementGateway on NEAR: views on the settlement contract (finality "final") and transactions from the
 * relayer account, which pays the gas for users' meta transactions and calls settle/refund as the operator.
 *
 * The indexer's "blocks" are the contract's payment sequence: `getLatestBlock()` is `paid_count()`, and
 * "block" n holds the payment with index n - 1, so block 0 means nothing paid yet.
 */
export class NearSettlementGateway implements NearGateway {
  private readonly rpc: NearRpc;
  private readonly settlementContract: string;
  private readonly relayerAccountId?: string;
  private readonly signer?: KeyPairSigner;
  private readonly pollingIntervalMs: number;
  private readonly receiptTimeoutMs: number;
  /** Payment transaction hashes this process relayed, by quote ID, for the indexer's events. */
  private readonly payTxHashes = new Map<string, Hex>();
  /** The relayer key's last used nonce, once known. */
  private relayerNonce?: bigint;
  /** Relayer transactions are signed one at a time, so nonces never collide. */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(options: NearSettlementGatewayOptions) {
    this.rpc = new NearRpc({ url: options.rpcUrl, ...(options.fetch ? { fetch: options.fetch } : {}) });
    this.settlementContract = options.settlementContract;
    if (options.relayerAccountId) this.relayerAccountId = options.relayerAccountId;
    if (options.relayerPrivateKey) this.signer = KeyPairSigner.fromSecretKey(options.relayerPrivateKey as KeyPairString);
    this.pollingIntervalMs = options.pollingIntervalMs ?? 1_000;
    this.receiptTimeoutMs = options.receiptTimeoutMs ?? 120_000;
  }

  /** Relays the user's signed delegate action: a transaction from the relayer to the sender, with one Delegate action. */
  async submitPayment({ quote }: SignedQuote, authorization: PaymentAuthorization): Promise<Hex> {
    if (authorization.kind !== 'near-delegate') {
      throw new AppError('invalid_authorization', 'This server settles on NEAR; send signedDelegate', 422);
    }
    const bytes = decodeBase64(authorization.signedDelegate);
    if (!bytes) throw new AppError('invalid_authorization', 'signedDelegate is not base64', 422);
    const { delegateAction, signature } = decodeSignedDelegate(bytes);
    const hash = await this.sendFromRelayer(delegateAction.senderId, [actions.signedDelegate({ delegateAction, signature })]);
    this.payTxHashes.set(quote.quoteId.toLowerCase(), hash);
    return hash;
  }

  markSettled(quoteId: Hex): Promise<Hex> {
    return this.operatorCall('settle', quoteId);
  }

  refund(quoteId: Hex): Promise<Hex> {
    return this.operatorCall('refund', quoteId);
  }

  async submitTransfer(): Promise<Hex> {
    throw new AppError('not_configured', 'Tap to pay is not available on the NEAR rail', 503);
  }

  async getTokenDomain(): Promise<{ name: string; version: string }> {
    throw new AppError('not_configured', 'EIP-712 token domains do not exist on the NEAR rail', 503);
  }

  async waitForReceipt(txHash: Hex): Promise<TxReceipt> {
    const deadline = Date.now() + this.receiptTimeoutMs;
    for (;;) {
      const receipt = await this.receipt(txHash, 'EXECUTED').catch((error: unknown) => {
        // Not seen yet, or the node's own wait timed out: ask again.
        if (error instanceof NearRpcError && ['UNKNOWN_TRANSACTION', 'TIMEOUT_ERROR'].includes(error.kind)) return null;
        throw error;
      });
      if (receipt) return receipt;
      if (Date.now() > deadline) throw new ChainUnavailableError(`timed out waiting for NEAR transaction ${txHash}`);
      await sleep(this.pollingIntervalMs);
    }
  }

  async getReceipt(txHash: Hex): Promise<TxReceipt | null> {
    return this.receipt(txHash, 'NONE').catch((error: unknown) => {
      if (error instanceof NearRpcError && error.kind === 'UNKNOWN_TRANSACTION') return null;
      throw error;
    });
  }

  async getLatestBlock(): Promise<bigint> {
    return BigInt(await this.view<number | string>(this.settlementContract, 'paid_count'));
  }

  async getPaymentReceivedEvents(fromBlock: bigint, toBlock: bigint): Promise<PaymentReceivedEvent[]> {
    const fromIndex = fromBlock > 0n ? fromBlock - 1n : 0n;
    if (toBlock < 1n || toBlock - 1n < fromIndex) return [];
    const limit = toBlock - fromIndex;
    const views = await this.view<NearPaymentView[]>(this.settlementContract, 'get_paid_events', {
      from_index: Number(fromIndex),
      limit: Number(limit),
    });
    return views.map((view) => this.toEvent(view));
  }

  async getPaymentStatus(quoteId: Hex): Promise<OnChainPaymentStatus> {
    const view = await this.view<NearPaymentView | null>(this.settlementContract, 'get_payment', { quote_id: quoteId });
    if (!view) return 'None';
    const status = STATUSES[view.status];
    if (!status) throw new ChainUnavailableError(`Unexpected payment status from the settlement contract: ${view.status}`);
    return status;
  }

  async getTokenBalance(token: Address, owner: Address): Promise<bigint> {
    return BigInt(await this.view<string>(token, 'ft_balance_of', { account_id: owner }));
  }

  /** The relayer's account and balance in yoctoNEAR (in `wei`, the port's field). */
  async getRelayerBalance(): Promise<{ address: Address; wei: bigint } | null> {
    if (!this.relayerAccountId || !this.signer) return null;
    const account = await this.read(() => this.rpc.viewAccount(this.relayerAccountId as string));
    return { address: this.relayerAccountId as Address, wei: BigInt(account.amount) };
  }

  async getAccessKeyNonce(accountId: string, publicKey: string): Promise<bigint | null> {
    try {
      const key = await this.rpc.viewAccessKey(accountId, publicKey);
      return BigInt(key.nonce);
    } catch (error) {
      if (error instanceof NearRpcError && ['UNKNOWN_ACCOUNT', 'UNKNOWN_ACCESS_KEY'].includes(error.kind)) return null;
      throw unavailable(error);
    }
  }

  async getFinalBlockHeight(): Promise<bigint> {
    const block = await this.read(() => this.rpc.block({ finality: 'final' }));
    return BigInt(block.header.height);
  }

  /** True if the account exists on-chain. */
  async accountExists(accountId: string): Promise<boolean> {
    try {
      await this.rpc.viewAccount(accountId);
      return true;
    } catch (error) {
      if (error instanceof NearRpcError && error.kind === 'UNKNOWN_ACCOUNT') return false;
      throw unavailable(error);
    }
  }

  /** A view call with `finality: "final"`. */
  view<T>(contractId: string, methodName: string, args: object = {}): Promise<T> {
    return this.read(() => this.rpc.viewFunction<T>(contractId, methodName, args));
  }

  /**
   * Signs and sends a transaction from the relayer. Returns its hash once the node accepted it.
   * The node refusing it (bad nonce, too little balance) means nothing was sent: TransactionRejectedError.
   * Failing to reach the node after signing may or may not have sent it: ChainUnavailableError with the hash.
   */
  sendFromRelayer(receiverId: string, txActions: Action[]): Promise<Hex> {
    const run = this.queue.then(() => this.send(receiverId, txActions));
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async send(receiverId: string, txActions: Action[]): Promise<Hex> {
    const { accountId, signer } = this.relayer();
    const publicKey = await signer.getPublicKey();
    for (let attempt = 0; ; attempt++) {
      const [nonce, blockHash] = await Promise.all([this.nextRelayerNonce(accountId, publicKey), this.recentBlockHash()]);
      const transaction = createTransaction(accountId, publicKey, receiverId, nonce, txActions, baseDecode(blockHash));
      const { txHash, signedTransaction } = await signer.signTransaction(transaction);
      const hash = baseEncode(txHash) as Hex;
      try {
        await this.rpc.sendTx(encodeBase64(signedTransaction.encode()), 'NONE');
        this.relayerNonce = nonce;
        return hash;
      } catch (error) {
        if (error instanceof NearRpcError && error.kind === 'INVALID_TRANSACTION') {
          const reason = JSON.stringify(error.data ?? error.message);
          // Another process (or a restart) used the key: read the nonce again, once.
          if (attempt === 0 && reason.includes('InvalidNonce')) {
            this.relayerNonce = undefined;
            continue;
          }
          throw new TransactionRejectedError(reason);
        }
        throw new ChainUnavailableError(`could not send the NEAR transaction: ${(error as Error).message}`, hash);
      }
    }
  }

  private async nextRelayerNonce(accountId: string, publicKey: PublicKey): Promise<bigint> {
    if (this.relayerNonce === undefined) {
      const key = await this.read(() => this.rpc.viewAccessKey(accountId, publicKey.toString()));
      this.relayerNonce = BigInt(key.nonce);
    }
    return this.relayerNonce + 1n;
  }

  private async recentBlockHash(): Promise<string> {
    return (await this.read(() => this.rpc.block({ finality: 'final' }))).header.hash;
  }

  private async operatorCall(methodName: 'settle' | 'refund', quoteId: Hex): Promise<Hex> {
    return this.sendFromRelayer(this.settlementContract, [
      actions.functionCall(methodName, { quote_id: quoteId }, OPERATOR_CALL_GAS, 0n),
    ]);
  }

  /** The outcome once every receipt ran; reverted if the transaction or any of its receipts failed. */
  private async receipt(txHash: Hex, waitUntil: 'NONE' | 'EXECUTED'): Promise<TxReceipt | null> {
    const { accountId } = this.relayer();
    const outcome = await this.rpc.txStatus(txHash, accountId, waitUntil).catch((error: unknown) => {
      if (error instanceof NearRpcError) throw error;
      throw unavailable(error);
    });
    if (!['EXECUTED', 'FINAL'].includes(outcome.final_execution_status ?? '')) return null;
    return { status: failed(outcome) ? 'reverted' : 'success', blockNumber: await this.blockHeight(outcome) };
  }

  /** Height of the block that included the transaction, for operators; 0 if it can't be read. */
  private async blockHeight(outcome: FinalExecutionOutcome): Promise<bigint> {
    const blockHash = outcome.transaction_outcome?.block_hash;
    if (!blockHash) return 0n;
    return this.rpc
      .block({ block_id: blockHash })
      .then((block) => BigInt(block.header.height))
      .catch(() => 0n);
  }

  private toEvent(view: NearPaymentView): PaymentReceivedEvent {
    const quoteId = view.quote_id as Hex;
    const txHash = this.payTxHashes.get(quoteId.toLowerCase());
    return {
      quoteId,
      payer: view.payer as Address,
      token: view.token as Address,
      tokenAmount: BigInt(view.token_amount),
      fiatCurrency: view.fiat_currency,
      fiatAmount: BigInt(view.fiat_amount),
      merchantRefHash: view.merchant_ref_hash as Hex,
      ...(txHash ? { txHash } : {}),
      blockNumber: BigInt(view.paid_block),
      logIndex: Number(view.index),
    };
  }

  private relayer(): { accountId: string; signer: KeyPairSigner } {
    if (!this.relayerAccountId || !this.signer) {
      throw new AppError('not_configured', 'NEAR_RELAYER_ACCOUNT_ID and NEAR_RELAYER_PRIVATE_KEY are not set', 503);
    }
    return { accountId: this.relayerAccountId, signer: this.signer };
  }

  /** A read: an unreachable node, or an error the node reports, is ChainUnavailableError (nothing was sent). */
  private async read<T>(call: () => Promise<T>): Promise<T> {
    try {
      return await call();
    } catch (error) {
      throw unavailable(error);
    }
  }
}

function unavailable(error: unknown): ChainUnavailableError {
  if (error instanceof ChainUnavailableError) return error;
  const message = error instanceof NearRpcError || error instanceof NearRpcUnavailableError ? error.message : String(error);
  return new ChainUnavailableError(message);
}

function failed(outcome: FinalExecutionOutcome): boolean {
  const isFailure = (status: unknown) => typeof status === 'object' && status !== null && 'Failure' in status;
  return isFailure(outcome.status) || (outcome.receipts_outcome ?? []).some((receipt) => isFailure(receipt.outcome.status));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
