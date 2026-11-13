import {
  type Address,
  type Chain,
  type Hex,
  type PublicClient,
  TransactionReceiptNotFoundError,
  type Transport,
  createPublicClient,
  defineChain,
  hexToString,
  http,
  parseSignature,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import type { ReceiveAuthorization, SignedQuote } from '../../domain/quote.js';
import { quoteStruct } from '../../lib/typed-data.js';
import {
  ChainUnavailableError,
  type OnChainPaymentStatus,
  type PaymentReceivedEvent,
  type SettlementGateway,
  type TxReceipt,
} from '../../ports/settlement-gateway.js';
import { AppError } from '../../shared/errors.js';
import { ON_CHAIN_STATUS, erc20Abi, settlementAbi } from './abi.js';
import { Relayer } from './relayer.js';

export interface ViemSettlementGatewayOptions {
  rpcUrl: string;
  chainId: number;
  settlementAddress?: Address;
  /** Key holding OPERATOR_ROLE. Pays gas for pay/markSettled/refund. */
  relayerPrivateKey?: Hex;
  /** How often to poll for receipts. */
  pollingIntervalMs?: number;
  /** How long to wait for a receipt before giving up (the transaction may still land later). */
  receiptTimeoutMs?: number;
  /** Overrides the HTTP transport (tests). */
  transport?: Transport;
}

/** SettlementGateway backed by viem: reads through a public client, writes through the Relayer. */
export class ViemSettlementGateway implements SettlementGateway {
  private readonly client: PublicClient;
  private readonly chain: Chain;
  private readonly transport: Transport;
  private readonly settlementAddress?: Address;
  private readonly relayerPrivateKey?: Hex;
  private readonly receiptTimeoutMs: number;
  private relayer?: Relayer;
  private readonly tokenDomains = new Map<string, Promise<{ name: string; version: string }>>();

  constructor(options: ViemSettlementGatewayOptions) {
    this.chain = defineChain({
      id: options.chainId,
      name: `chain-${options.chainId}`,
      nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
      rpcUrls: { default: { http: [options.rpcUrl] } },
    });
    this.transport = options.transport ?? http(options.rpcUrl);
    this.client = createPublicClient({
      chain: this.chain,
      transport: this.transport,
      pollingInterval: options.pollingIntervalMs ?? 1_000,
    });
    if (options.settlementAddress) this.settlementAddress = options.settlementAddress;
    if (options.relayerPrivateKey) this.relayerPrivateKey = options.relayerPrivateKey;
    this.receiptTimeoutMs = options.receiptTimeoutMs ?? 120_000;
  }

  async submitPayment({ quote, signature }: SignedQuote, authorization: ReceiveAuthorization): Promise<Hex> {
    const { v, yParity, r, s } = parseSignature(authorization.signature);
    return this.write('pay', [
      quoteStruct(quote),
      signature,
      {
        validAfter: authorization.validAfter,
        validBefore: authorization.validBefore,
        v: v === undefined ? yParity + 27 : Number(v),
        r,
        s,
      },
    ]);
  }

  async markSettled(quoteId: Hex): Promise<Hex> {
    return this.write('markSettled', [quoteId]);
  }

  async refund(quoteId: Hex): Promise<Hex> {
    return this.write('refund', [quoteId]);
  }

  async waitForReceipt(txHash: Hex): Promise<TxReceipt> {
    const receipt = await this.read(() =>
      this.client.waitForTransactionReceipt({ hash: txHash, timeout: this.receiptTimeoutMs }),
    );
    return { status: receipt.status, blockNumber: receipt.blockNumber };
  }

  async getReceipt(txHash: Hex): Promise<TxReceipt | null> {
    try {
      const receipt = await this.client.getTransactionReceipt({ hash: txHash });
      return { status: receipt.status, blockNumber: receipt.blockNumber };
    } catch (error) {
      if (error instanceof TransactionReceiptNotFoundError) return null;
      throw unavailable(error);
    }
  }

  async getLatestBlock(): Promise<bigint> {
    return this.read(() => this.client.getBlockNumber({ cacheTime: 0 }));
  }

  async getPaymentReceivedEvents(fromBlock: bigint, toBlock: bigint): Promise<PaymentReceivedEvent[]> {
    const address = this.requireSettlement();
    const logs = await this.read(() =>
      this.client.getContractEvents({
        address,
        abi: settlementAbi,
        eventName: 'PaymentReceived',
        fromBlock,
        toBlock,
        strict: true,
      }),
    );
    return logs.map((log) => ({
      quoteId: log.args.quoteId,
      payer: log.args.payer,
      token: log.args.token,
      tokenAmount: log.args.tokenAmount,
      fiatCurrency: hexToString(log.args.fiatCurrency, { size: 3 }),
      fiatAmount: log.args.fiatAmount,
      merchantRefHash: log.args.merchantRefHash,
      txHash: log.transactionHash,
      blockNumber: log.blockNumber,
      logIndex: log.logIndex,
    }));
  }

  async getPaymentStatus(quoteId: Hex): Promise<OnChainPaymentStatus> {
    const address = this.requireSettlement();
    const payment = await this.read(() =>
      this.client.readContract({ address, abi: settlementAbi, functionName: 'paymentOf', args: [quoteId] }),
    );
    const status = ON_CHAIN_STATUS[payment.status];
    if (!status) throw new AppError('chain_unavailable', `Unknown payment status ${payment.status}`, 503);
    return status;
  }

  async getTokenBalance(token: Address, owner: Address): Promise<bigint> {
    return this.read(() => this.client.readContract({ address: token, abi: erc20Abi, functionName: 'balanceOf', args: [owner] }));
  }

  async getRelayerBalance(): Promise<{ address: Address; wei: bigint } | null> {
    if (!this.relayerPrivateKey) return null;
    const { address } = privateKeyToAccount(this.relayerPrivateKey);
    return { address, wei: await this.read(() => this.client.getBalance({ address })) };
  }

  /**
   * Reads `name()` and `version()` from the token. USDC's values differ between networks
   * (and the mock's match Base Sepolia's), so they're never hardcoded. Cached per token;
   * a failed read isn't cached.
   */
  async getTokenDomain(token: Address): Promise<{ name: string; version: string }> {
    const key = token.toLowerCase();
    let domain = this.tokenDomains.get(key);
    if (!domain) {
      domain = this.readTokenDomain(token);
      this.tokenDomains.set(key, domain);
      domain.catch(() => this.tokenDomains.delete(key));
    }
    return domain;
  }

  private async readTokenDomain(token: Address): Promise<{ name: string; version: string }> {
    try {
      const [name, version] = await Promise.all([
        this.client.readContract({ address: token, abi: erc20Abi, functionName: 'name' }),
        this.client.readContract({ address: token, abi: erc20Abi, functionName: 'version' }),
      ]);
      return { name, version };
    } catch (error) {
      throw new AppError(
        'chain_unavailable',
        `Could not read the EIP-712 domain of token ${token}: ${(error as Error).message.split('\n')[0]}`,
        503,
      );
    }
  }

  private write(functionName: 'pay' | 'markSettled' | 'refund', args: readonly unknown[]): Promise<Hex> {
    const address = this.requireSettlement();
    return this.getRelayer().send({ address, abi: settlementAbi, functionName, args });
  }

  private getRelayer(): Relayer {
    if (!this.relayerPrivateKey) {
      throw new AppError('not_configured', 'Sending transactions needs RELAYER_PRIVATE_KEY to be set', 503);
    }
    this.relayer ??= new Relayer({
      account: privateKeyToAccount(this.relayerPrivateKey),
      chain: this.chain,
      transport: this.transport,
      publicClient: this.client,
    });
    return this.relayer;
  }

  private requireSettlement(): Address {
    if (!this.settlementAddress) {
      throw new AppError('not_configured', 'Chain access needs SETTLEMENT_ADDRESS to be set', 503);
    }
    return this.settlementAddress;
  }

  private async read<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (error) {
      throw unavailable(error);
    }
  }
}

function unavailable(error: unknown): ChainUnavailableError {
  const message = error instanceof Error ? error.message.split('\n')[0] : String(error);
  return new ChainUnavailableError(`Chain read failed: ${message}`);
}
