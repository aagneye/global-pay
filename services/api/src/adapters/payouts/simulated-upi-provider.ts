import { createHash } from 'node:crypto';
import type { Merchant } from '../../domain/merchant.js';
import type { FiatAmount } from '../../domain/money.js';
import type { PayoutProvider, PayoutRequest, PayoutResult } from '../../ports/payout-provider.js';
import { SimulatedPromptPayProvider, type SimulatedPromptPayOptions } from './simulated-promptpay-provider.js';

/**
 * Stand-in for an Indian UPI payout partner paying a merchant's UPI ID in rupees (testnet).
 * No money moves. Same timing, failures and statelessness as SimulatedPromptPayProvider (PAYOUT_DELAY_MS,
 * PAYOUT_FAILURE_RATE); a paid payout's reference is a 12-digit UTR, as UPI gives.
 */
export class SimulatedUpiProvider implements PayoutProvider {
  readonly name = 'simulated-upi';
  private readonly inner: SimulatedPromptPayProvider;

  constructor(options: Omit<SimulatedPromptPayOptions, 'float'>) {
    this.inner = new SimulatedPromptPayProvider(options);
  }

  supports(merchant: Merchant): boolean {
    return merchant.kind === 'upi';
  }

  async createPayout(request: PayoutRequest): Promise<PayoutResult> {
    if (request.merchant.kind !== 'upi' || request.amount.currency !== 'INR') {
      return { status: 'failed', reason: 'Only UPI payouts in INR are supported', providerStatus: 'UNSUPPORTED' };
    }
    return this.inner.createPayout(request);
  }

  async getPayout(providerRef: string): Promise<PayoutResult> {
    return withUtr(await this.inner.getPayout(providerRef));
  }

  async findByIdempotencyKey(idempotencyKey: string): Promise<PayoutResult | null> {
    const result = await this.inner.findByIdempotencyKey(idempotencyKey);
    return result && withUtr(result);
  }

  /** No float check for UPI on testnet. */
  async getBalance(): Promise<FiatAmount | null> {
    return null;
  }
}

function withUtr(result: PayoutResult): PayoutResult {
  return result.status === 'succeeded' ? { ...result, reference: utr(result.providerRef) } : result;
}

/** A UPI transaction reference (UTR): 12 digits, fixed by the payout. */
function utr(providerRef: string): string {
  const value = createHash('sha256').update(`upi:${providerRef}`).digest().readBigUInt64BE(0) % 10n ** 12n;
  return value.toString().padStart(12, '0');
}
