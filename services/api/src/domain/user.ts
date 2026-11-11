import type { Address } from 'viem';

export type KycTier = 0 | 1 | 2;
export type KycStatus = 'PENDING' | 'APPROVED' | 'REJECTED';

export interface User {
  id: string;
  /** Lowercase 0x address of the user's wallet. */
  walletAddress: Address;
  kycTier: KycTier;
  kycStatus: KycStatus;
}

/**
 * Spending limits per KYC tier, in THB satang.
 * DEMO VALUES ONLY: real limits come from the partner and the regulator (Thai sandbox caps).
 */
export const LIMITS_BY_TIER: Record<KycTier, { perPayment: bigint; perDay: bigint }> = {
  0: { perPayment: 0n, perDay: 0n },
  1: { perPayment: 5_000_00n, perDay: 20_000_00n },
  2: { perPayment: 50_000_00n, perDay: 200_000_00n },
};
