import type { KycStatus, KycTier } from '../domain/user.js';

export interface KycSession {
  provider: string;
  /** Token the mobile SDK uses to run the verification flow. */
  sessionToken: string;
  expiresAt: Date;
}

export interface KycResult {
  status: KycStatus;
  tier: KycTier;
  providerRef?: string;
}

/** Identity verification partner (demo: MockKycProvider; production: e.g. Sumsub). */
export interface KycProvider {
  readonly name: string;
  startVerification(userId: string): Promise<KycSession>;
  getResult(userId: string): Promise<KycResult>;
}
