import type { Address, Hex } from 'viem';
import type { FiatAmount } from './money.js';
import type { Merchant } from './merchant.js';

/**
 * A price quote for paying a PromptPay QR with a stablecoin.
 * Mirrors `IGlobalPaySettlement.Quote` on-chain, plus off-chain context.
 *
 * On the NEAR rail (SETTLEMENT_RAIL=near), `payer` holds the payer's NEAR account ID and `token` the
 * USDC contract's account ID. They keep the EVM types so the shared code stays as it is.
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
  /** Normalised payee reference, e.g. "promptpay:biller:099999999999901" or "upi:chai@okaxis". */
  merchantRef: string;
  /** keccak256 of `merchantRef`. */
  merchantRefHash: Hex;
  merchant: Merchant;
  expiresAt: Date;
}

/**
 * A quote plus the backend's signature over it: EIP-712 (0x hex) on the EVM rail; on the NEAR rail,
 * ed25519 over the quote JSON the settlement contract checks, as base64 (typed Hex for the shared code).
 */
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

/**
 * NEAR rail: the `ft_transfer_call` the user's key signs as a NEP-366 delegate action, which the relayer
 * submits (and pays the gas for). The app checks it against its own settings before signing.
 */
export interface NearPaymentToSign {
  /** The payer's implicit account. */
  signerId: string;
  /** The payer's key, "ed25519:" + base58. */
  publicKey: string;
  /** The USDC contract. */
  receiverId: string;
  methodName: 'ft_transfer_call';
  args: { receiver_id: string; amount: string; msg: string };
  gas: bigint;
  /** yoctoNEAR: `ft_transfer_call` needs exactly 1. */
  deposit: bigint;
  /** The access key's nonce + 1. */
  nonce: bigint;
  /** The delegate action is void after this block. */
  maxBlockHeight: bigint;
}

/** The user's signed ReceiveWithAuthorization, as submitted to POST /payments (EVM rail). */
export interface ReceiveAuthorization {
  kind?: 'eip3009';
  validAfter: bigint;
  validBefore: bigint;
  signature: Hex;
}

/** The user's signed NEP-366 delegate action for `nearPayment` (NEAR rail). */
export interface NearDelegateAuthorization {
  kind: 'near-delegate';
  /** base64 of the borsh-encoded SignedDelegate. */
  signedDelegate: string;
}

/** What the user signed to pay a quote, per settlement rail. */
export type PaymentAuthorization = ReceiveAuthorization | NearDelegateAuthorization;

export interface QuoteRequest {
  userId: string;
  payer: Address;
  qrPayload: string;
  /** Required when the QR is static (has no amount). THB satang. */
  fiatAmountMinor?: bigint;
}
