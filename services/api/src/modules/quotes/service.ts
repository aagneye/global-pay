import { randomBytes } from 'node:crypto';
import { type Address, type Hex, bytesToHex, getAddress } from 'viem';
import type { Merchant } from '../../domain/merchant.js';
import { isPersonalQr } from '../../domain/merchant.js';
import { FIAT_DECIMALS, type FiatAmount, TOKEN_DECIMALS } from '../../domain/money.js';
import { type Price, priceInToken } from '../../domain/pricing.js';
import type { AuthorizationToSign, NearPaymentToSign, Quote, QuoteRequest, SignedQuote } from '../../domain/quote.js';
import { merchantRefOf, parseMerchantQr } from '../../lib/merchant.js';
import { merchantRefHash } from '../../lib/promptpay/merchant-ref.js';
import { toUnixSeconds } from '../../lib/typed-data.js';
import type { PayoutProvider } from '../../ports/payout-provider.js';
import type { QuoteSigner } from '../../ports/quote-signer.js';
import type { RateProvider } from '../../ports/rate-provider.js';
import type { KycRepository, PaymentRepository, QuoteRepository, UserRepository } from '../../ports/repositories.js';
import type { SettlementGateway } from '../../ports/settlement-gateway.js';
import { AppError } from '../../shared/errors.js';
import { parseWallet } from '../../shared/schemas.js';
import { FT_TRANSFER_CALL } from '../../adapters/near/delegate.js';
import { publicKeyOfImplicitAccount } from '../../adapters/near/keys.js';
import { nearTransferMsg } from '../../adapters/near/quote-message.js';
import type { NearRail } from '../../ports/near-chain.js';
import { enforceSpendingLimit, limitAmountThb } from '../kyc/limits.js';

/** Gas for the user's `ft_transfer_call` (the settlement contract's ft_on_transfer runs inside it). */
export const NEAR_PAYMENT_GAS = 100_000_000_000_000n;
/** The delegate action stays valid this many blocks (about 5 minutes; the quote expires sooner). */
export const NEAR_PAYMENT_BLOCKS = 300n;

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
  /** Set on the NEAR rail: quotes carry `nearPayment` instead of `authorizationToSign`. */
  near?: NearRail;
  quoteTtlSeconds: number;
  spreadBps: number;
  merchantQrOnly: boolean;
  /** The payout partner for each kind of QR (PayoutRouter): can it pay this QR, and is there enough float? */
  payoutRail: { forMerchant(merchant: Merchant): Pick<PayoutProvider, 'supports' | 'getBalance'> | undefined };
  /** Refuse THB quotes that would leave less than this in the payout float (THB satang). */
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
 * Turns a scanned PromptPay (THB) or UPI (INR) QR into a signed, short-lived quote:
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
    parseWallet(deps.near ? 'near' : 'evm', request.payer);
    const settlementAddress = deps.settlementAddress;
    if (!deps.near && !settlementAddress) {
      throw new AppError('not_configured', 'Quotes need SETTLEMENT_ADDRESS to be set', 503);
    }

    // 1. The QR and what it allows.
    const merchant = parseMerchantQr(request.qrPayload);
    if (deps.merchantQrOnly && isPersonalQr(merchant)) {
      throw new AppError('personal_qr_not_allowed', 'Only merchant QRs can be paid', 422);
    }
    const payoutRail = deps.payoutRail.forMerchant(merchant);
    if (!payoutRail?.supports(merchant)) {
      throw new AppError('merchant_not_supported', "This kind of QR can't be paid yet", 422);
    }
    const fiatMinor = resolveAmount(merchant.amount?.minor, request.fiatAmountMinor);
    const fiat: FiatAmount = { currency: merchant.kind === 'upi' ? 'INR' : 'THB', minor: fiatMinor };

    // 2. Who pays, and whether they may.
    const user = await deps.users.findById(request.userId);
    if (!user) throw new AppError('unauthorized', 'Unknown user; sign in again', 401);
    if (user.walletAddress !== request.payer.toLowerCase()) {
      throw new AppError('payer_mismatch', 'The payer must be the wallet you signed in with', 403);
    }
    const now = this.now();
    // KYC limits are in THB: a THB payment is checked before pricing, another currency at its THB equivalent.
    if (fiat.currency === 'THB') await enforceSpendingLimit(deps, user.id, fiatMinor, now);
    await this.ensureFloat(payoutRail, fiat);

    // 3. Price it, at the rate for the QR's currency.
    const rate = await deps.rates.getRate('USDC', fiat.currency);
    const price = priceInToken({
      fiatMinor,
      fiatDecimals: FIAT_DECIMALS[fiat.currency],
      tokenDecimals: TOKEN_DECIMALS.USDC,
      rateE8: rate.rateE8,
      spreadBps: deps.spreadBps,
    });
    if (fiat.currency !== 'THB') {
      await enforceSpendingLimit(deps, user.id, await limitAmountThb(deps.rates, fiat, price.tokenAmount), now);
    }
    // What the wallet will sign needs chain reads: the token's EIP-712 domain, or the NEAR key's nonce.
    const chain = deps.near
      ? { near: await this.nearAccount(deps.near, request.payer) }
      : { tokenDomain: await deps.gateway.getTokenDomain(deps.usdcAddress) };

    // 4. Sign and store. Expiry is on a whole second, because the contract stores seconds.
    const expiresAt = new Date((Math.floor(now.getTime() / 1000) + deps.quoteTtlSeconds) * 1000);
    const ref = merchantRefOf(merchant);
    const quote: Quote = {
      quoteId: this.newQuoteId(),
      payer: deps.near ? request.payer : getAddress(request.payer),
      token: deps.near ? (deps.near.usdcContract as Address) : getAddress(deps.usdcAddress),
      tokenAmount: price.tokenAmount,
      fiat,
      rateE8: rate.rateE8,
      spreadBps: deps.spreadBps,
      merchantRef: ref,
      merchantRefHash: merchantRefHash(ref),
      merchant,
      expiresAt,
    };
    const signature = await deps.signer.sign(quote);
    await deps.quotes.create(user.id, { quote, signature });

    const response = { quote, signature, pricing: { ...price, rateSource: rate.source } };
    if (deps.near && chain.near) {
      const { publicKey, nonce, height } = chain.near;
      return {
        ...response,
        nearPayment: {
          signerId: quote.payer,
          publicKey,
          receiverId: deps.near.usdcContract,
          methodName: FT_TRANSFER_CALL,
          args: {
            receiver_id: deps.near.settlementContract,
            amount: quote.tokenAmount.toString(),
            msg: nearTransferMsg(quote, signature),
          },
          gas: NEAR_PAYMENT_GAS,
          deposit: 1n,
          nonce: nonce + 1n,
          maxBlockHeight: height + NEAR_PAYMENT_BLOCKS,
        },
      };
    }
    return {
      ...response,
      authorizationToSign: {
        domain: { ...(chain.tokenDomain as { name: string; version: string }), chainId: deps.chainId, verifyingContract: quote.token },
        message: {
          from: quote.payer,
          to: getAddress(settlementAddress as Address),
          value: quote.tokenAmount,
          validAfter: 0n,
          validBefore: toUnixSeconds(expiresAt),
          nonce: quote.quoteId,
        },
      },
    };
  }

  /** The payer's key (its implicit account's), the key's nonce and the final block height, for the delegate action. */
  private async nearAccount(near: NearRail, payer: string): Promise<{ publicKey: string; nonce: bigint; height: bigint }> {
    const publicKey = publicKeyOfImplicitAccount(payer);
    const [nonce, height] = await Promise.all([near.chain.getAccessKeyNonce(payer, publicKey), near.chain.getFinalBlockHeight()]);
    if (nonce === null) {
      throw new AppError(
        'near_account_not_found',
        "Your NEAR account doesn't exist on-chain yet: it needs a little NEAR first (on testnet, sign in again to get test funds)",
        422,
      );
    }
    return { publicKey, nonce, height };
  }

  /**
   * The partner must hold enough of the payout currency to pay this, plus a buffer (THB only). A partner that
   * doesn't report a float (the simulated UPI partner) isn't checked. Unreadable float: refuse, to be safe.
   */
  private async ensureFloat(rail: Pick<PayoutProvider, 'getBalance'>, fiat: FiatAmount): Promise<void> {
    let float;
    try {
      float = await rail.getBalance();
    } catch {
      throw new AppError('payouts_unavailable', "Payouts are unavailable right now; you haven't been charged", 503);
    }
    if (!float) return;
    const buffer = fiat.currency === 'THB' ? this.deps.payoutFloatBufferMinor : 0n;
    if (float.currency !== fiat.currency || float.minor - fiat.minor < buffer) {
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
