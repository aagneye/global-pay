import { type Address, type Hex, isAddressEqual, recoverTypedDataAddress } from 'viem';
import type { ReceiveAuthorization } from '../../domain/quote.js';
import { RECEIVE_WITH_AUTHORIZATION_TYPES } from '../../lib/typed-data.js';
import type { KycRepository, PaymentRepository, QuoteRepository, StoredQuote } from '../../ports/repositories.js';
import {
  ChainUnavailableError,
  type SettlementGateway,
  TransactionRejectedError,
} from '../../ports/settlement-gateway.js';
import { AppError } from '../../shared/errors.js';
import { enforceSpendingLimit } from '../kyc/limits.js';
import { type PaymentView, toPaymentView } from './view.js';

export interface PaymentServiceDeps {
  quotes: QuoteRepository;
  payments: PaymentRepository;
  kyc: KycRepository;
  gateway: SettlementGateway;
  chainId: number;
  settlementAddress?: Address;
  explorerUrl: string;
  now?: () => Date;
}

export interface SubmitPaymentInput {
  userId: string;
  quoteId: Hex;
  authorization: ReceiveAuthorization;
}

/**
 * Accepts the user's signed USDC authorisation for a quote and relays `pay()`.
 * After that, the indexer and payout worker drive the payment to SETTLED or REFUNDED.
 */
export class PaymentService {
  private readonly deps: PaymentServiceDeps;
  private readonly now: () => Date;

  constructor(deps: PaymentServiceDeps) {
    this.deps = deps;
    this.now = deps.now ?? (() => new Date());
  }

  /**
   * Checks everything that can be checked off-chain, records the payment as SUBMITTED, and sends pay().
   * Submitting the same quote again returns the existing payment.
   */
  async submit({ userId, quoteId, authorization }: SubmitPaymentInput): Promise<PaymentView> {
    const { deps } = this;
    const stored = await deps.quotes.findById(quoteId);
    if (!stored || stored.userId !== userId) {
      throw new AppError('quote_not_found', 'No such quote for this user', 404);
    }
    const existing = await deps.payments.findByQuoteId(quoteId);
    if (existing) return this.view(existing.id);

    const now = this.now();
    if (now >= stored.quote.expiresAt) {
      throw new AppError('quote_expired', 'The quote has expired; get a new one', 422);
    }
    await this.checkAuthorization(stored, authorization);
    // The tier, or other payments, may have changed since the quote.
    await enforceSpendingLimit(deps, userId, stored.quote.fiat.minor, now);

    const { payment, created } = await deps.payments.createForQuote(quoteId, userId);
    if (!created) return this.view(payment.id); // a concurrent submission got there first

    try {
      const txHash = await deps.gateway.submitPayment(stored, authorization);
      await deps.payments.update(payment.id, { payTxHash: txHash });
    } catch (error) {
      await this.handleSendError(payment.id, error);
    }
    return this.view(payment.id);
  }

  async get(userId: string, paymentId: string): Promise<PaymentView> {
    const found = await this.deps.payments.findById(paymentId);
    if (!found || found.payment.userId !== userId) {
      throw new AppError('payment_not_found', 'No such payment for this user', 404);
    }
    return toPaymentView(found, this.deps.explorerUrl);
  }

  /** The user's payments, newest first. */
  async list(userId: string, limit = 50): Promise<PaymentView[]> {
    const items = await this.deps.payments.listByUser(userId, limit);
    return items.map((item) => toPaymentView(item, this.deps.explorerUrl));
  }

  /** The signature must be the payer's, over exactly this quote. Checking it here saves a doomed transaction. */
  private async checkAuthorization({ quote }: StoredQuote, authorization: ReceiveAuthorization): Promise<void> {
    const settlementAddress = this.deps.settlementAddress;
    if (!settlementAddress) {
      throw new AppError('not_configured', 'Payments need SETTLEMENT_ADDRESS to be set', 503);
    }
    const domain = await this.deps.gateway.getTokenDomain(quote.token);
    const signer = await recoverTypedDataAddress({
      domain: { ...domain, chainId: this.deps.chainId, verifyingContract: quote.token },
      types: RECEIVE_WITH_AUTHORIZATION_TYPES,
      primaryType: 'ReceiveWithAuthorization',
      message: {
        from: quote.payer,
        to: settlementAddress,
        value: quote.tokenAmount,
        validAfter: authorization.validAfter,
        validBefore: authorization.validBefore,
        nonce: quote.quoteId,
      },
      signature: authorization.signature,
    }).catch(() => null);
    if (!signer || !isAddressEqual(signer, quote.payer)) {
      throw new AppError(
        'invalid_authorization',
        "The signature isn't the payer's authorisation for this quote; sign authorizationToSign unchanged",
        422,
      );
    }
  }

  /**
   * - The contract would revert: nothing was sent, so the payment FAILED.
   * - The chain was unreachable and nothing was signed: FAILED too.
   * - A transaction was signed but its fate is unknown: keep it SUBMITTED with its hash.
   *   The indexer picks it up if it lands; the reconciler fails it if it doesn't before the quote expires.
   */
  private async handleSendError(paymentId: string, error: unknown): Promise<void> {
    if (error instanceof ChainUnavailableError && error.txHash) {
      await this.deps.payments.update(paymentId, { payTxHash: error.txHash });
      return;
    }
    const reason =
      error instanceof TransactionRejectedError ? error.reason : error instanceof Error ? error.message : String(error);
    await this.deps.payments.transition(paymentId, 'SUBMITTED', 'FAILED', { failureReason: reason });
    if (error instanceof TransactionRejectedError) {
      throw new AppError('payment_rejected', `The payment would fail on-chain: ${error.reason}`, 422);
    }
    throw error;
  }

  private async view(paymentId: string): Promise<PaymentView> {
    const found = await this.deps.payments.findById(paymentId);
    if (!found) throw new AppError('payment_not_found', 'No such payment', 404);
    return toPaymentView(found, this.deps.explorerUrl);
  }
}
