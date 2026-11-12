import type { Address, Hex } from 'viem';
import type { FiatAmount } from './money.js';
import type { PromptPayQr } from './promptpay.js';

/**
 * A price quote for paying a PromptPay QR with a stablecoin.
 * Mirrors `IGlobalPaySettlement.Quote` on-chain, plus off-chain context.
 */
export interface Quote {
  /** bytes32, unique. Also the EIP-3009 nonce, so a user signature fits exactly one quote. */
  quoteId: Hex;
  payer: Address;
  token: Address;
  /** Token base units (USDC: 6 decimals). */
  tokenAmount: bigint;
  fiat: FiatAmount;
  /** Fiat major units per 1 token, scaled by RATE_SCALE (1e8), before the spread. */
  rateE8: bigint;
  spreadBps: number;
  /** Normalised payee reference, e.g. "promptpay:biller:099999999999901". */
  merchantRef: string;
  /** keccak256 of `merchantRef`. */
  merchantRefHash: Hex;
  merchant: PromptPayQr;
  expiresAt: Date;
}

/** A quote plus the backend's EIP-712 signature over it. */
export interface SignedQuote {
  quote: Quote;
  signature: Hex;
}

/** EIP-712 data the user's wallet signs: USDC ReceiveWithAuthorization. */
export interface AuthorizationToSign {
  domain: { name: string; version: string; chainId: number; verifyingContract: Address };
  message: {
    from: Address;
    to: Address;
    value: bigint;
    validAfter: bigint;
    validBefore: bigint;
    nonce: Hex;
  };
}

/** The user's signed ReceiveWithAuthorization, as submitted to POST /payments. */
export interface ReceiveAuthorization {
  validAfter: bigint;
  validBefore: bigint;
  signature: Hex;
}

export interface QuoteRequest {
  userId: string;
  payer: Address;
  qrPayload: string;
  /** Required when the QR is static (has no amount). THB satang. */
  fiatAmountMinor?: bigint;
}
