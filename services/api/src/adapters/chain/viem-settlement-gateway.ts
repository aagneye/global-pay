import {
  type Address,
  type Hex,
  type PublicClient,
  type Transport,
  createPublicClient,
  http,
  parseAbi,
} from 'viem';
import type { ReceiveAuthorization, SignedQuote } from '../../domain/quote.js';
import type {
  PaymentReceivedEvent,
  SettlementGateway,
  TxReceipt,
} from '../../ports/settlement-gateway.js';
import { AppError, NotImplementedError } from '../../shared/errors.js';

export interface ViemSettlementGatewayOptions {
  rpcUrl: string;
  chainId: number;
  settlementAddress?: Address;
  /** Key holding OPERATOR_ROLE. Pays gas for pay/markSettled/refund. */
  relayerPrivateKey?: Hex;
  /** Overrides the HTTP transport (tests). */
  transport?: Transport;
}

const EIP712_TOKEN_ABI = parseAbi([
  'function name() view returns (string)',
  'function version() view returns (string)',
]);

/** SettlementGateway backed by viem public and wallet clients. */
export class ViemSettlementGateway implements SettlementGateway {
  private readonly options: ViemSettlementGatewayOptions;
  private readonly client: PublicClient;
  private readonly tokenDomains = new Map<string, Promise<{ name: string; version: string }>>();

  constructor(options: ViemSettlementGatewayOptions) {
    this.options = options;
    this.client = createPublicClient({ transport: options.transport ?? http(options.rpcUrl) });
  }

  async submitPayment(_signed: SignedQuote, _authorization: ReceiveAuthorization): Promise<Hex> {
    throw new NotImplementedError('Relayer pay()', 4);
  }

  async markSettled(_quoteId: Hex): Promise<Hex> {
    throw new NotImplementedError('Relayer markSettled()', 4);
  }

  async refund(_quoteId: Hex): Promise<Hex> {
    throw new NotImplementedError('Relayer refund()', 4);
  }

  async waitForReceipt(_txHash: Hex): Promise<TxReceipt> {
    throw new NotImplementedError('Receipt tracking', 4);
  }

  async getLatestBlock(): Promise<bigint> {
    throw new NotImplementedError('Block reads', 4);
  }

  async getPaymentReceivedEvents(_fromBlock: bigint, _toBlock: bigint): Promise<PaymentReceivedEvent[]> {
    throw new NotImplementedError('Event indexing', 4);
  }

  async getTokenBalance(_token: Address, _owner: Address): Promise<bigint> {
    throw new NotImplementedError('Balance reads', 4);
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
        this.client.readContract({ address: token, abi: EIP712_TOKEN_ABI, functionName: 'name' }),
        this.client.readContract({ address: token, abi: EIP712_TOKEN_ABI, functionName: 'version' }),
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
}
