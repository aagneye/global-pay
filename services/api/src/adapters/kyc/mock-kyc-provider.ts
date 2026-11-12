import { randomBytes } from 'node:crypto';
import type { KycTier } from '../../domain/user.js';
import type { KycProvider, KycResult, KycSession } from '../../ports/kyc-provider.js';

export interface MockKycProviderOptions {
  /** Tier granted on approval. */
  tier?: Exclude<KycTier, 0>;
  now?: () => Date;
}

/**
 * Demo KYC: no documents, no checks. Starting verification returns a fake session,
 * and the result is always APPROVED at tier 1, so the payment flow can be exercised.
 * Replaced by a real provider (e.g. Sumsub) before any real money moves.
 */
export class MockKycProvider implements KycProvider {
  readonly name = 'mock';
  private readonly tier: Exclude<KycTier, 0>;
  private readonly now: () => Date;

  constructor(options: MockKycProviderOptions = {}) {
    this.tier = options.tier ?? 1;
    this.now = options.now ?? (() => new Date());
  }

  async startVerification(_userId: string): Promise<KycSession> {
    return {
      provider: this.name,
      sessionToken: `mock_${randomBytes(16).toString('hex')}`,
      expiresAt: new Date(this.now().getTime() + 30 * 60 * 1000),
    };
  }

  async getResult(userId: string): Promise<KycResult> {
    return { status: 'APPROVED', tier: this.tier, providerRef: `mock-${userId}` };
  }
}
