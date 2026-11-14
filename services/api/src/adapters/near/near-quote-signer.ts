import { KeyPair, type KeyPairString } from 'near-api-js';
import type { Address, Hex } from 'viem';
import type { Quote } from '../../domain/quote.js';
import type { QuoteSigner } from '../../ports/quote-signer.js';
import { encodeBase64 } from './keys.js';
import { nearQuoteJson } from './quote-message.js';

/**
 * Signs quotes for the NEAR settlement contract: ed25519 over the UTF-8 bytes of the quote JSON
 * (`nearQuoteJson`), returned as base64. The contract holds the public key (`quote_signer_pk`).
 */
export class NearQuoteSigner implements QuoteSigner {
  private readonly key: KeyPair;

  constructor(privateKey: string) {
    this.key = KeyPair.fromString(privateKey as KeyPairString);
  }

  /** The public key, "ed25519:" + base58 (typed Address for the shared port). */
  get address(): Address {
    return this.key.getPublicKey().toString() as Address;
  }

  async sign(quote: Quote): Promise<Hex> {
    const { signature } = this.key.sign(new TextEncoder().encode(nearQuoteJson(quote)));
    return encodeBase64(signature) as Hex;
  }
}
