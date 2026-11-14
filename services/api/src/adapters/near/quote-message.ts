import type { Quote } from '../../domain/quote.js';

/**
 * The quote as the NEAR settlement contract reads it, shared with contracts-near (ft_on_transfer):
 * a JSON object with exactly these keys, in this order. Big numbers are strings; `expires_at_ms` is a
 * number. `quote_id` and `merchant_ref_hash` are the 0x bytes32 values the EVM rail uses too.
 *
 * The backend signs the exact UTF-8 bytes of this string with ed25519 (NEAR_QUOTE_SIGNER_PRIVATE_KEY).
 */
export function nearQuoteJson(quote: Quote): string {
  return JSON.stringify({
    quote_id: quote.quoteId,
    payer: quote.payer,
    token: quote.token,
    token_amount: quote.tokenAmount.toString(),
    fiat_currency: quote.fiat.currency,
    fiat_amount: quote.fiat.minor.toString(),
    merchant_ref_hash: quote.merchantRefHash,
    expires_at_ms: quote.expiresAt.getTime(),
  });
}

/**
 * `ft_transfer_call`'s msg: {"quote": <the quote JSON, as a string>, "signature": <base64 ed25519 over it>}.
 * The quote stays a string so the contract verifies exactly the bytes that were signed.
 */
export function nearTransferMsg(quote: Quote, signatureBase64: string): string {
  return JSON.stringify({ quote: nearQuoteJson(quote), signature: signatureBase64 });
}
