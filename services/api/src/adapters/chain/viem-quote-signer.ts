import type { Address, Hex } from 'viem';
import type { Quote } from '../../domain/quote.js';
import type { QuoteSigner } from '../../ports/quote-signer.js';
import { NotImplementedError } from '../../shared/errors.js';

export interface ViemQuoteSignerOptions {
  privateKey?: Hex;
  chainId: number;
  /** EIP-712 verifyingContract. */
  settlementAddress?: Address;
}

/**
 * Signs quotes with a local viem account, using the EIP-712 domain
 * { name: "GlobalPay Settlement", version: "1", chainId, verifyingContract }.
 */
export class ViemQuoteSigner implements QuoteSigner {
  private readonly options: ViemQuoteSignerOptions;

  constructor(options: ViemQuoteSignerOptions) {
    this.options = options;
  }

  get address(): Address {
    throw new NotImplementedError('Quote signer', 3);
  }

  async sign(_quote: Quote): Promise<Hex> {
    throw new NotImplementedError('Quote signer', 3);
  }
}
