import type { Address, Hex } from 'viem';
import type { Quote } from '../domain/quote.js';

/**
 * Signs quotes as EIP-712 typed data that GlobalPaySettlement verifies.
 * Demo: a local viem account. Production: a KMS-backed signer.
 */
export interface QuoteSigner {
  /** Must hold QUOTE_SIGNER_ROLE on the settlement contract. */
  readonly address: Address;
  sign(quote: Quote): Promise<Hex>;
}
