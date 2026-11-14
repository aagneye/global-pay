import { randomBytes } from 'node:crypto';
import { type Address, type Hex, bytesToHex, getAddress } from 'viem';
import { FIAT_DECIMALS, TOKEN_DECIMALS } from '../../domain/money.js';
import { type Price, priceInToken } from '../../domain/pricing.js';
import type { AuthorizationToSign, NearPaymentToSign, Quote, QuoteRequest, SignedQuote } from '../../domain/quote.js';
import { merchantRef, merchantRefHash } from '../../lib/promptpay/merchant-ref.js';
import { parsePromptPayQr } from '../../lib/promptpay/parse.js';
import { toUnixSeconds } from '../../lib/typed-data.js';
import type { PayoutProvider } from '../../ports/payout-provider.js';
import type { QuoteSigner } from '../../ports/quote-signer.js';
import type { RateProvider } from '../../ports/rate-provider.js';
import type { KycRepository, PaymentRepository, QuoteRepository, UserRepository } from '../../ports/repositories.js';
import type { SettlementGateway } from '../../ports/settlement-gateway.js';
import { AppError } from '../../shared/errors.js';
import { parseWallet } from '../../shared/schemas.js';
import { enforceSpendingLimit } from '../kyc/limits.js';

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
  /** The active payout rail: can it pay this QR, and is there enough float? */
  payoutRail: Pick<PayoutProvider, 'supports' | 'getBalance'>;
  /** Refuse quotes that would leave less than this in the payout float (THB satang). */
  payoutFloatBufferMinor: bigint;
  now?: () => Date;
  newQuoteId?: () => Hex;
}

export interface QuoteResponse extends SignedQuote {
  pricing: Price & { rateSource: string };
  /** EVM rail: what the user's wallet must sign (USDC ReceiveWithAuthorization, nonce = quoteId). */
  authorizationToSign?: AuthorizationToSign;
  /** NEAR rail: the `ft_transfer_call` the user's key signs as a delegate action. */
  nearPayment?: NearPaymentToSign;
}

/**
 * Turns a scanned PromptPay QR into a signed, short-lived quote:
 * parse QR → policy (merchant-only, payout rail, amount, payer, KYC limits, float) → rate + spread → sign → store.
 *
 * Everything that would stop the payout is checked here, before the user pays anything.
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
    parseWallet('evm', request.payer);
    const settlementAddress = deps.settlementAddress;
    if (!settlementAddress) {
      throw new AppError('not_configured', 'Quotes need SETTLEMENT_ADDRESS to be set', 503);
    }

    // 1. The QR and what it allows.
    const merchant = parsePromptPayQr(request.qrPayload);
    if (deps.merchantQrOnly && merchant.kind === 'personal') {
      throw new AppError('personal_qr_not_allowed', 'Only merchant PromptPay QRs can be paid', 422);
    }
    if (!deps.payoutRail.supports(merchant)) {
      throw new AppError('merchant_not_supported', "This kind of PromptPay QR can't be paid yet", 422);
    }
    const fiatMinor = resolveAmount(merchant.amount?.minor, request.fiatAmountMinor);

    // 2. Who pays, and whether they may.
    const user = await deps.users.findById(request.userId);
    if (!user) throw new AppError('unauthorized', 'Unknown user; sign in again', 401);
    if (user.walletAddress !== request.payer.toLowerCase()) {
      throw new AppError('payer_mismatch', 'The payer must be the wallet you signed in with', 403);
    }
    const now = this.now();
    await enforceSpendingLimit(deps, user.id, fiatMinor, now);
    await this.ensureFloat(fiatMinor);

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

  /** The partner must hold enough THB to pay this, plus a buffer. Unreadable float: refuse, to be safe. */
  private async ensureFloat(fiatMinor: bigint): Promise<void> {
    let float;
    try {
      float = await this.deps.payoutRail.getBalance();
    } catch {
      throw new AppError('payouts_unavailable', "Payouts are unavailable right now; you haven't been charged", 503);
    }
    if (float && float.minor - fiatMinor < this.deps.payoutFloatBufferMinor) {
      throw new AppError('payouts_unavailable', "Payouts are unavailable right now; you haven't been charged", 503);
    }
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
