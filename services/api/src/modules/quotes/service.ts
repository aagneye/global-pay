import { randomBytes } from 'node:crypto';
import { type Address, type Hex, bytesToHex, getAddress } from 'viem';
import { FIAT_DECIMALS, TOKEN_DECIMALS, formatMinor } from '../../domain/money.js';
import { type Price, priceInToken } from '../../domain/pricing.js';
import type { AuthorizationToSign, Quote, QuoteRequest, SignedQuote } from '../../domain/quote.js';
import { checkSpendingLimit, effectiveTier } from '../../domain/user.js';
import { merchantRef, merchantRefHash } from '../../lib/promptpay/merchant-ref.js';
import { parsePromptPayQr } from '../../lib/promptpay/parse.js';
import { toUnixSeconds } from '../../lib/typed-data.js';
import type { QuoteSigner } from '../../ports/quote-signer.js';
import type { RateProvider } from '../../ports/rate-provider.js';
import type { KycRepository, PaymentRepository, QuoteRepository, UserRepository } from '../../ports/repositories.js';
import type { SettlementGateway } from '../../ports/settlement-gateway.js';
import { AppError } from '../../shared/errors.js';

export interface QuoteServiceDeps {
  users: UserRepository;
  kyc: KycRepository;
  payments: PaymentRepository;
  quotes: QuoteRepository;
  rates: RateProvider;
  signer: QuoteSigner;
  gateway: SettlementGateway;
  chainId: number;
  usdcAddress: Address;
  settlementAddress?: Address;
  quoteTtlSeconds: number;
  spreadBps: number;
  merchantQrOnly: boolean;
  now?: () => Date;
  newQuoteId?: () => Hex;
}

export interface QuoteResponse extends SignedQuote {
  pricing: Price & { rateSource: string };
  /** What the user's wallet must sign (USDC ReceiveWithAuthorization, nonce = quoteId). */
  authorizationToSign: AuthorizationToSign;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Turns a scanned PromptPay QR into a signed, short-lived quote:
 * parse QR → policy (merchant-only, amount, payer, KYC limits) → rate + spread → sign → store.
 */
export class QuoteService {
  private readonly deps: QuoteServiceDeps;
  private readonly now: () => Date;
  private readonly newQuoteId: () => Hex;

  constructor(deps: QuoteServiceDeps) {
    this.deps = deps;
    this.now = deps.now ?? (() => new Date());
    this.newQuoteId = deps.newQuoteId ?? (() => bytesToHex(randomBytes(32)));
  }

  async createQuote(request: QuoteRequest): Promise<QuoteResponse> {
    const { deps } = this;
    const settlementAddress = deps.settlementAddress;
    if (!settlementAddress) {
      throw new AppError('not_configured', 'Quotes need SETTLEMENT_ADDRESS to be set', 503);
    }

    // 1. The QR and what it allows.
    const merchant = parsePromptPayQr(request.qrPayload);
    if (deps.merchantQrOnly && merchant.kind === 'personal') {
      throw new AppError('personal_qr_not_allowed', 'Only merchant PromptPay QRs can be paid', 422);
    }
    const fiatMinor = resolveAmount(merchant.amount?.minor, request.fiatAmountMinor);

    // 2. Who pays, and whether they may.
    const user = await deps.users.findById(request.userId);
    if (!user) throw new AppError('unauthorized', 'Unknown user; sign in again', 401);
    if (user.walletAddress !== request.payer.toLowerCase()) {
      throw new AppError('payer_mismatch', 'The payer must be the wallet you signed in with', 403);
    }
    const now = this.now();
    const tier = effectiveTier(await deps.kyc.find(user.id));
    const spent = await deps.payments.sumFiatSince(user.id, new Date(now.getTime() - DAY_MS));
    const violation = checkSpendingLimit(tier, fiatMinor, spent);
    if (violation?.code === 'kyc_required') {
      throw new AppError('kyc_required', 'Complete identity verification before paying', 403);
    }
    if (violation?.code === 'payment_limit_exceeded') {
      throw new AppError('payment_limit_exceeded', `The limit per payment is ${thb(violation.limit)}`, 422);
    }
    if (violation?.code === 'daily_limit_exceeded') {
      throw new AppError(
        'daily_limit_exceeded',
        `The 24-hour limit is ${thb(violation.limit)}; ${thb(violation.remaining)} remains`,
        422,
      );
    }

    // 3. Price it.
    const rate = await deps.rates.getRate('USDC', 'THB');
    const price = priceInToken({
      fiatMinor,
      fiatDecimals: FIAT_DECIMALS.THB,
      tokenDecimals: TOKEN_DECIMALS.USDC,
      rateE8: rate.rateE8,
      spreadBps: deps.spreadBps,
    });
    const tokenDomain = await deps.gateway.getTokenDomain(deps.usdcAddress);

    // 4. Sign and store. Expiry is on a whole second, because the contract stores seconds.
    const expiresAt = new Date((Math.floor(now.getTime() / 1000) + deps.quoteTtlSeconds) * 1000);
    const ref = merchantRef(merchant);
    const quote: Quote = {
      quoteId: this.newQuoteId(),
      payer: getAddress(request.payer),
      token: getAddress(deps.usdcAddress),
      tokenAmount: price.tokenAmount,
      fiat: { currency: 'THB', minor: fiatMinor },
      rateE8: rate.rateE8,
      spreadBps: deps.spreadBps,
      merchantRef: ref,
      merchantRefHash: merchantRefHash(ref),
      merchant,
      expiresAt,
    };
    const signature = await deps.signer.sign(quote);
    await deps.quotes.create(user.id, { quote, signature });

    return {
      quote,
      signature,
      pricing: { ...price, rateSource: rate.source },
      authorizationToSign: {
        domain: { ...tokenDomain, chainId: deps.chainId, verifyingContract: quote.token },
        message: {
          from: quote.payer,
          to: getAddress(settlementAddress),
          value: quote.tokenAmount,
          validAfter: 0n,
          validBefore: toUnixSeconds(expiresAt),
          nonce: quote.quoteId,
        },
      },
    };
  }
}

/** A dynamic QR fixes the amount; a static one needs the user to enter it. */
function resolveAmount(qrAmount: bigint | undefined, requested: bigint | undefined): bigint {
  if (qrAmount !== undefined) {
    if (requested !== undefined && requested !== qrAmount) {
      throw new AppError('amount_mismatch', 'This QR has a fixed amount; leave fiatAmountMinor out or match it', 422);
    }
    return qrAmount;
  }
  if (requested === undefined) {
    throw new AppError('amount_required', 'This QR has no amount; send fiatAmountMinor', 422);
  }
  if (requested <= 0n) throw new AppError('invalid_amount', 'The amount must be positive', 422);
  return requested;
}

function thb(minor: bigint): string {
  return `${formatMinor(minor, FIAT_DECIMALS.THB)} THB`;
}
