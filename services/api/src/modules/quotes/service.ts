import type { Address } from 'viem';
import type { AuthorizationToSign, QuoteRequest, SignedQuote } from '../../domain/quote.js';
import type { KycProvider } from '../../ports/kyc-provider.js';
import type { QuoteSigner } from '../../ports/quote-signer.js';
import type { RateProvider } from '../../ports/rate-provider.js';
import type { SettlementGateway } from '../../ports/settlement-gateway.js';
import { NotImplementedError } from '../../shared/errors.js';

export interface QuoteServiceDeps {
  rates: RateProvider;
  signer: QuoteSigner;
  kyc: KycProvider;
  gateway: SettlementGateway;
  usdcAddress: Address;
  quoteTtlSeconds: number;
  spreadBps: number;
  merchantQrOnly: boolean;
}

export interface QuoteResponse extends SignedQuote {
  /** What the user's wallet must sign (USDC ReceiveWithAuthorization, nonce = quoteId). */
  authorizationToSign: AuthorizationToSign;
}

/**
 * Turns a scanned PromptPay QR into a signed, short-lived quote:
 * parse QR → policy (merchant-only, KYC limits) → rate + spread → sign → store.
 */
export class QuoteService {
  private readonly deps: QuoteServiceDeps;

  constructor(deps: QuoteServiceDeps) {
    this.deps = deps;
  }

  async createQuote(_request: QuoteRequest): Promise<QuoteResponse> {
    throw new NotImplementedError('Quotes', 3);
  }
}
