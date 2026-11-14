import type { Address } from 'viem';

export interface User {
  id: string;
  /** Lowercase 0x address of the user's wallet. */
  walletAddress: Address;
  /** The name others see when paying this user. */
  displayName?: string;
  /** True only when the name comes from identity verification, not from the user. */
  nameVerified?: boolean;
}

export type KycTier = 0 | 1 | 2;
export type KycStatus = 'PENDING' | 'APPROVED' | 'REJECTED';

/** The user's verification with the KYC partner. A user with no record hasn't started KYC. */
export interface KycRecord {
  userId: string;
  provider: string;
  providerRef?: string;
  tier: KycTier;
  status: KycStatus;
}

/** Only an approved verification grants its tier. Everyone else is tier 0 and can't pay. */
export function effectiveTier(record: KycRecord | null): KycTier {
  return record?.status === 'APPROVED' ? record.tier : 0;
}

export interface SpendingLimits {
  perPayment: bigint;
  /** Rolling 24 hours. */
  perDay: bigint;
}

/**
 * Spending limits per KYC tier, in THB satang.
 * DEMO VALUES ONLY: real limits come from the partner and the regulator (Thai sandbox caps).
 */
export const LIMITS_BY_TIER: Record<KycTier, SpendingLimits> = {
  0: { perPayment: 0n, perDay: 0n },
  1: { perPayment: 5_000_00n, perDay: 20_000_00n },
  2: { perPayment: 50_000_00n, perDay: 200_000_00n },
};

export type LimitViolation =
  | { code: 'kyc_required' }
  | { code: 'payment_limit_exceeded'; limit: bigint }
  | { code: 'daily_limit_exceeded'; limit: bigint; remaining: bigint };

/**
 * Checks a new payment against the tier's limits.
 * `spentLast24h` is what the user already paid in the rolling 24 hours (excluding failed and refunded payments).
 */
export function checkSpendingLimit(tier: KycTier, amount: bigint, spentLast24h: bigint): LimitViolation | null {
  if (tier === 0) return { code: 'kyc_required' };
  const limits = LIMITS_BY_TIER[tier];
  if (amount > limits.perPayment) return { code: 'payment_limit_exceeded', limit: limits.perPayment };
  if (spentLast24h + amount > limits.perDay) {
    const remaining = limits.perDay > spentLast24h ? limits.perDay - spentLast24h : 0n;
    return { code: 'daily_limit_exceeded', limit: limits.perDay, remaining };
  }
  return null;
}
