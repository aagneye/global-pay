import type { Address, Hex } from 'viem';
import type { ReceiveAuthorization, SignedQuote } from '../../domain/quote.js';
import type {
  PaymentReceivedEvent,
  SettlementGateway,
  TxReceipt,
} from '../../ports/settlement-gateway.js';
import { NotImplementedError } from '../../shared/errors.js';

export interface ViemSettlementGatewayOptions {
  rpcUrl: string;
  chainId: number;
  settlementAddress?: Address;
  /** Key holding OPERATOR_ROLE. Pays gas for pay/markSettled/refund. */
  relayerPrivateKey?: Hex;
}

/** SettlementGateway backed by viem public and wallet clients. */
export class ViemSettlementGateway implements SettlementGateway {
  private readonly options: ViemSettlementGatewayOptions;

  constructor(options: ViemSettlementGatewayOptions) {
    this.options = options;
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

  async getTokenDomain(_token: Address): Promise<{ name: string; version: string }> {
    throw new NotImplementedError('Token EIP-712 domain', 3);
  }
}
