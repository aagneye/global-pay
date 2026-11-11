import type { Hex } from 'viem';
import type { Payment } from '../../domain/payment.js';
import type { ReceiveAuthorization } from '../../domain/quote.js';
import type { SettlementGateway } from '../../ports/settlement-gateway.js';
import { NotImplementedError } from '../../shared/errors.js';

export interface PaymentServiceDeps {
  gateway: SettlementGateway;
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

  constructor(deps: PaymentServiceDeps) {
    this.deps = deps;
  }

  async submit(_input: SubmitPaymentInput): Promise<Payment> {
    throw new NotImplementedError('Payment submission', 4);
  }

  async get(_userId: string, _paymentId: string): Promise<Payment> {
    throw new NotImplementedError('Payment status', 4);
  }
}
