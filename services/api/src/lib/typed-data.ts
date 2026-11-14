import { type Address, type Hex, hashTypedData, stringToHex } from 'viem';
import type { Quote } from '../domain/quote.js';

/**
 * EIP-712 definitions shared with the contracts. They must match exactly:
 * - `Quote` and the domain: contracts/src/GlobalPaySettlement.sol (QUOTE_TYPEHASH, EIP712 name/version)
 * - `ReceiveWithAuthorization`: USDC's EIP-3009 (contracts/src/interfaces/IERC3009.sol)
 * - `TransferWithAuthorization`: USDC's EIP-3009, for person-to-person payments (tap to pay)
 */

export const SETTLEMENT_DOMAIN = { name: 'GlobalPay Settlement', version: '1' } as const;

export const QUOTE_TYPES = {
  Quote: [
    { name: 'quoteId', type: 'bytes32' },
    { name: 'payer', type: 'address' },
    { name: 'token', type: 'address' },
    { name: 'tokenAmount', type: 'uint256' },
    { name: 'fiatCurrency', type: 'bytes3' },
    { name: 'fiatAmount', type: 'uint256' },
    { name: 'merchantRefHash', type: 'bytes32' },
    { name: 'expiresAt', type: 'uint64' },
  ],
} as const;

export const RECEIVE_WITH_AUTHORIZATION_TYPES = {
  ReceiveWithAuthorization: [
    { name: 'from', type: 'address' },
    { name: 'to', type: 'address' },
    { name: 'value', type: 'uint256' },
    { name: 'validAfter', type: 'uint256' },
    { name: 'validBefore', type: 'uint256' },
    { name: 'nonce', type: 'bytes32' },
  ],
} as const;

export const TRANSFER_WITH_AUTHORIZATION_TYPES = {
  TransferWithAuthorization: [
    { name: 'from', type: 'address' },
    { name: 'to', type: 'address' },
    { name: 'value', type: 'uint256' },
    { name: 'validAfter', type: 'uint256' },
    { name: 'validBefore', type: 'uint256' },
    { name: 'nonce', type: 'bytes32' },
  ],
} as const;

/** The on-chain fields of a quote, as the contract's `Quote` struct. */
export function quoteStruct(quote: Quote) {
  return {
    quoteId: quote.quoteId,
    payer: quote.payer,
    token: quote.token,
    tokenAmount: quote.tokenAmount,
    fiatCurrency: stringToHex(quote.fiat.currency, { size: 3 }),
    fiatAmount: quote.fiat.minor,
    merchantRefHash: quote.merchantRefHash,
    expiresAt: toUnixSeconds(quote.expiresAt),
  };
}

export function quoteTypedData(quote: Quote, chainId: number, settlementAddress: Address) {
  return {
    domain: { ...SETTLEMENT_DOMAIN, chainId, verifyingContract: settlementAddress },
    types: QUOTE_TYPES,
    primaryType: 'Quote' as const,
    message: quoteStruct(quote),
  };
}

/** The digest the quote signer signs. Equals `GlobalPaySettlement.hashQuote(quote)`. */
export function hashQuote(quote: Quote, chainId: number, settlementAddress: Address): Hex {
  return hashTypedData(quoteTypedData(quote, chainId, settlementAddress));
}

/** Quote expiry as uint64 unix seconds. Quotes are created on whole seconds, so nothing is lost. */
export function toUnixSeconds(date: Date): bigint {
  return BigInt(Math.floor(date.getTime() / 1000));
}
