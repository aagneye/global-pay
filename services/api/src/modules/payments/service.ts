import { type Address, type Hex, isAddressEqual, recoverTypedDataAddress } from 'viem';
import type { PaymentAuthorization, ReceiveAuthorization } from '../../domain/quote.js';
import { RECEIVE_WITH_AUTHORIZATION_TYPES } from '../../lib/typed-data.js';
import type { KycRepository, PaymentRepository, QuoteRepository, StoredQuote } from '../../ports/repositories.js';
import {
  ChainUnavailableError,
  type SettlementGateway,
  TransactionRejectedError,
} from '../../ports/settlement-gateway.js';
import { AppError } from '../../shared/errors.js';
import { checkSignedDelegate } from '../../adapters/near/delegate.js';
import { nearTransferMsg } from '../../adapters/near/quote-message.js';
import type { NearRail } from '../../ports/near-chain.js';
import { enforceSpendingLimit } from '../kyc/limits.js';
import { type PaymentView, toPaymentView } from './view.js';

export interface PaymentServiceDeps {
  quotes: QuoteRepository;
  payments: PaymentRepository;
  kyc: KycRepository;
  gateway: SettlementGateway;
  chainId: number;
  settlementAddress?: Address;
  /** Set on the NEAR rail: payments are signed delegate actions, checked against the quote here. */
  near?: NearRail;
  explorerUrl: string;
  /** Path to a transaction on the explorer: "tx" (Etherscan-style) or "txns" (nearblocks). */
  explorerTxPath?: string;
  now?: () => Date;
}

export interface SubmitPaymentInput {
  userId: string;
  quoteId: Hex;
  authorization: PaymentAuthorization;
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

    let txHash: Hex;
    try {
      txHash = await deps.gateway.submitPayment(stored, authorization);
    } catch (error) {
      await this.handleSendError(payment.id, error);
      return this.view(payment.id);
    }
    // Sent. Whatever happens now, the payment stays SUBMITTED: if the hash can't be saved, the indexer
    // still finds the payment by its event (or fails it once the quote expired and the chain shows none).
    await deps.payments.update(payment.id, { payTxHash: txHash }).catch(() => undefined);
    return this.view(payment.id);
  }

  async get(userId: string, paymentId: string): Promise<PaymentView> {
    const found = await this.deps.payments.findById(paymentId);
    if (!found || found.payment.userId !== userId) {
      throw new AppError('payment_not_found', 'No such payment for this user', 404);
    }
    return toPaymentView(found, this.deps.explorerUrl, this.deps.explorerTxPath);
  }

  /** The user's payments, newest first. */
  async list(userId: string, limit = 50): Promise<PaymentView[]> {
    const items = await this.deps.payments.listByUser(userId, limit);
    return items.map((item) => toPaymentView(item, this.deps.explorerUrl, this.deps.explorerTxPath));
  }

  /** The signature must be the payer's, over exactly this quote. Checking it here saves a doomed transaction. */
  private async checkAuthorization(stored: StoredQuote, authorization: PaymentAuthorization): Promise<void> {
    const { near } = this.deps;
    if (near) {
      if (authorization.kind !== 'near-delegate') {
        throw new AppError('invalid_authorization', 'This server settles on NEAR; sign nearPayment and send signedDelegate', 422);
      }
      const { quote, signature } = stored;
      checkSignedDelegate(authorization.signedDelegate, {
        payer: quote.payer,
        usdcContract: near.usdcContract,
        settlementContract: near.settlementContract,
        tokenAmount: quote.tokenAmount,
        msg: nearTransferMsg(quote, signature),
        currentHeight: await near.chain.getFinalBlockHeight(),
      });
      return;
    }
    if (authorization.kind === 'near-delegate') {
      throw new AppError('invalid_authorization', 'This server settles on the EVM rail; sign authorizationToSign', 422);
    }
    await this.checkReceiveAuthorization(stored, authorization);
  }

  private async checkReceiveAuthorization({ quote }: StoredQuote, authorization: ReceiveAuthorization): Promise<void> {
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
   * Fails the payment only when nothing can have been sent:
   * - the contract would revert (the simulation said so);
   * - the chain was unreachable before anything was signed, or there's no relayer key.
   *
   * Anything else may have come after a transaction was signed and sent, so the payment stays SUBMITTED
   * (with its hash, if known). The indexer marks it PAID if it lands, or FAILED once the quote expired
   * and the chain shows no payment.
   */
  private async handleSendError(paymentId: string, error: unknown): Promise<void> {
    const nothingSent =
      error instanceof TransactionRejectedError ||
      (error instanceof ChainUnavailableError && !error.txHash) ||
      (error instanceof AppError && error.code === 'not_configured');
    if (!nothingSent) {
      if (error instanceof ChainUnavailableError && error.txHash) {
        await this.deps.payments.update(paymentId, { payTxHash: error.txHash }).catch(() => undefined);
      }
      return;
    }
    const reason = error instanceof TransactionRejectedError ? error.reason : (error as AppError).message;
    await this.deps.payments.transition(paymentId, 'SUBMITTED', 'FAILED', { failureReason: reason });
    if (error instanceof TransactionRejectedError) {
      throw new AppError('payment_rejected', `The payment would fail on-chain: ${error.reason}`, 422);
    }
    throw error;
  }

  private async view(paymentId: string): Promise<PaymentView> {
    const found = await this.deps.payments.findById(paymentId);
    if (!found) throw new AppError('payment_not_found', 'No such payment', 404);
    return toPaymentView(found, this.deps.explorerUrl, this.deps.explorerTxPath);
  }
}
