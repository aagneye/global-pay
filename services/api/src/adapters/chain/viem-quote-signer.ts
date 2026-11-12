import type { Address, Hex, PrivateKeyAccount } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import type { Quote } from '../../domain/quote.js';
import { quoteTypedData } from '../../lib/typed-data.js';
import type { QuoteSigner } from '../../ports/quote-signer.js';
import { AppError } from '../../shared/errors.js';

export interface ViemQuoteSignerOptions {
  privateKey?: Hex;
  chainId: number;
  /** EIP-712 verifyingContract. */
  settlementAddress?: Address;
}

/**
 * Signs quotes with a local viem account, using the EIP-712 domain
 * { name: "GlobalPay Settlement", version: "1", chainId, verifyingContract }.
 * The key's address must hold QUOTE_SIGNER_ROLE on the settlement contract.
 */
export class ViemQuoteSigner implements QuoteSigner {
  private readonly account?: PrivateKeyAccount;
  private readonly chainId: number;
  private readonly settlementAddress?: Address;

  constructor(options: ViemQuoteSignerOptions) {
    if (options.privateKey) this.account = privateKeyToAccount(options.privateKey);
    this.chainId = options.chainId;
    if (options.settlementAddress) this.settlementAddress = options.settlementAddress;
  }

  get address(): Address {
    return this.ready().account.address;
  }

  async sign(quote: Quote): Promise<Hex> {
    const { account, settlementAddress } = this.ready();
    return account.signTypedData(quoteTypedData(quote, this.chainId, settlementAddress));
  }

  private ready(): { account: PrivateKeyAccount; settlementAddress: Address } {
    if (!this.account || !this.settlementAddress) {
      throw new AppError(
        'not_configured',
        'Quote signing needs QUOTE_SIGNER_PRIVATE_KEY and SETTLEMENT_ADDRESS to be set',
        503,
      );
    }
    return { account: this.account, settlementAddress: this.settlementAddress };
  }
}
