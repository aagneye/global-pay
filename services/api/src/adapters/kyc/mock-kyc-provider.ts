import type { KycProvider, KycResult, KycSession } from '../../ports/kyc-provider.js';
import { NotImplementedError } from '../../shared/errors.js';

/**
 * Demo KYC: approves every user at tier 1 so the payment flow can be exercised.
 * Replaced by a real provider (e.g. Sumsub) before any real money moves.
 */
export class MockKycProvider implements KycProvider {
  readonly name = 'mock';

  async startVerification(_userId: string): Promise<KycSession> {
    throw new NotImplementedError('Mock KYC', 3);
  }

  async getResult(_userId: string): Promise<KycResult> {
    throw new NotImplementedError('Mock KYC', 3);
  }
}
