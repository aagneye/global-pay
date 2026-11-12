import {
  type Abi,
  type Account,
  type Address,
  BaseError,
  type Chain,
  ContractFunctionRevertedError,
  type Hex,
  NonceTooHighError,
  NonceTooLowError,
  type PublicClient,
  type Transport,
  type WalletClient,
  createWalletClient,
  encodeFunctionData,
  keccak256,
} from 'viem';
import { ChainUnavailableError, TransactionRejectedError } from '../../ports/settlement-gateway.js';

export interface ContractCall {
  address: Address;
  abi: Abi;
  functionName: string;
  args: readonly unknown[];
}

interface SignedTransaction {
  nonce: number;
  serializedTransaction: Hex;
  hash: Hex;
}

export interface RelayerOptions {
  account: Account;
  chain: Chain;
  transport: Transport;
  publicClient: PublicClient;
  /** Tries per transaction, for nonce clashes and unreachable nodes. */
  maxAttempts?: number;
  retryDelayMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Sends contract calls from one key (the relayer, holding OPERATOR_ROLE) and pays the gas.
 *
 * - **Simulate first:** a call that would revert throws TransactionRejectedError, decoded to the
 *   contract's error name, and nothing is sent.
 * - **Nonces:** calls go out one at a time, with a locally tracked nonce. If the node says the nonce
 *   is wrong (another process used the key, or the node restarted), it re-reads it and tries again.
 * - **Retries:** the transaction is signed locally, so its hash is known before sending. Resending the
 *   same bytes is safe, and "already known" counts as sent.
 *
 * Not handled (fine for the demo): replacing a transaction stuck with too low a gas price.
 */
export class Relayer {
  private readonly wallet: WalletClient<Transport, Chain, Account>;
  private readonly publicClient: PublicClient;
  private readonly chain: Chain;
  private readonly maxAttempts: number;
  private readonly retryDelayMs: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private queue: Promise<unknown> = Promise.resolve();
  private nextNonce: number | undefined;
  private chainChecked = false;

  constructor(options: RelayerOptions) {
    this.wallet = createWalletClient({ account: options.account, chain: options.chain, transport: options.transport });
    this.publicClient = options.publicClient;
    this.chain = options.chain;
    this.maxAttempts = options.maxAttempts ?? 3;
    this.retryDelayMs = options.retryDelayMs ?? 500;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  get address(): Address {
    return this.wallet.account.address;
  }

  /** Simulates, signs and broadcasts `call`. Resolves with the hash once a node has accepted it. */
  send(call: ContractCall): Promise<Hex> {
    const result = this.queue.then(() => this.sendNow(call));
    this.queue = result.catch(() => undefined);
    return result;
  }

  private async sendNow(call: ContractCall): Promise<Hex> {
    await this.checkChain();
    await this.simulate(call);
    const data = encodeFunctionData(call);

    let lastError: unknown;
    let lastHash: Hex | undefined;
    for (let round = 1; round <= this.maxAttempts; round++) {
      let signed: SignedTransaction;
      try {
        signed = await this.sign(call.address, data);
      } catch (error) {
        if (isRevert(error)) throw new TransactionRejectedError(revertReason(error));
        lastError = error;
        if (!isTransient(error)) break;
        await this.sleep(this.retryDelayMs * round);
        continue;
      }
      lastHash = signed.hash;
      const outcome = await this.broadcast(signed);
      if (outcome === 'sent') {
        this.nextNonce = signed.nonce + 1;
        return signed.hash;
      }
      this.nextNonce = undefined; // re-read it from the node
      if (outcome === 'stale-nonce') continue;
      lastError = outcome.error;
      break;
    }
    this.nextNonce = undefined;
    throw new ChainUnavailableError(`Could not send ${call.functionName}: ${shortMessage(lastError)}`, lastHash);
  }

  private async sign(to: Address, data: Hex): Promise<SignedTransaction> {
    const nonce = this.nextNonce ?? (await this.pendingNonce());
    const request = await this.wallet.prepareTransactionRequest({ to, data, nonce });
    const serializedTransaction = await this.wallet.signTransaction(request);
    return { nonce, serializedTransaction, hash: keccak256(serializedTransaction) };
  }

  /**
   * Sends the same signed bytes until a node accepts them. Resending is safe: it's the same
   * transaction, and finding it already in the pool counts as sent.
   */
  private async broadcast(signed: SignedTransaction): Promise<'sent' | 'stale-nonce' | { error: unknown }> {
    for (let attempt = 1; ; attempt++) {
      try {
        await this.wallet.sendRawTransaction({ serializedTransaction: signed.serializedTransaction });
        return 'sent';
      } catch (error) {
        if (await this.isKnown(signed.hash)) return 'sent';
        if (isNonceError(error)) return 'stale-nonce';
        if (!isTransient(error) || attempt >= this.maxAttempts) return { error };
        await this.sleep(this.retryDelayMs * attempt);
      }
    }
  }

  private async simulate(call: ContractCall): Promise<void> {
    try {
      await this.publicClient.simulateContract({ ...call, account: this.wallet.account });
    } catch (error) {
      if (isRevert(error)) throw new TransactionRejectedError(revertReason(error));
      throw new ChainUnavailableError(`Could not simulate ${call.functionName}: ${shortMessage(error)}`);
    }
  }

  private async pendingNonce(): Promise<number> {
    return this.publicClient.getTransactionCount({ address: this.address, blockTag: 'pending' });
  }

  private async isKnown(hash: Hex): Promise<boolean> {
    try {
      await this.publicClient.getTransaction({ hash });
      return true;
    } catch {
      return false;
    }
  }

  /** Signing for the wrong chain would only fail later and less clearly. */
  private async checkChain(): Promise<void> {
    if (this.chainChecked) return;
    let actual: number;
    try {
      actual = await this.publicClient.getChainId();
    } catch (error) {
      throw new ChainUnavailableError(`Could not reach the RPC node: ${shortMessage(error)}`);
    }
    if (actual !== this.chain.id) {
      throw new ChainUnavailableError(`RPC node is on chain ${actual}, but CHAIN_ID is ${this.chain.id}`);
    }
    this.chainChecked = true;
  }
}

function isRevert(error: unknown): error is BaseError {
  return error instanceof BaseError && error.walk((e) => e instanceof ContractFunctionRevertedError) !== null;
}

function isNonceError(error: unknown): boolean {
  return (
    error instanceof BaseError &&
    (error.walk((e) => e instanceof NonceTooLowError || e instanceof NonceTooHighError) !== null ||
      /replacement transaction underpriced/i.test(error.message))
  );
}

/** Anything that isn't a definite answer from the node: network errors, timeouts, rate limits. */
function isTransient(error: unknown): boolean {
  return error instanceof BaseError && /HTTP request failed|timed out|took too long|fetch failed|ECONN|429|503/i.test(error.message);
}

/** The contract's error name ("QuoteExpired"), a revert message, or the raw selector. */
export function revertReason(error: BaseError): string {
  const revert = error.walk((e) => e instanceof ContractFunctionRevertedError) as ContractFunctionRevertedError | null;
  return revert?.data?.errorName ?? revert?.reason ?? revert?.signature ?? error.shortMessage;
}

function shortMessage(error: unknown): string {
  if (error instanceof BaseError) return error.shortMessage;
  return error instanceof Error ? error.message : String(error);
}
