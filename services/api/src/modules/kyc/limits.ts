import { FIAT_DECIMALS, formatMinor } from '../../domain/money.js';
import { checkSpendingLimit, effectiveTier } from '../../domain/user.js';
import type { KycRepository, PaymentRepository } from '../../ports/repositories.js';
import { AppError } from '../../shared/errors.js';

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Throws unless the user's KYC tier allows paying `amount` (THB satang) now: approved KYC,
 * within the per-payment limit, and within the rolling 24-hour limit.
 * Checked when quoting and again when the payment is submitted.
 */
export async function enforceSpendingLimit(
  deps: { kyc: KycRepository; payments: PaymentRepository },
  userId: string,
  amount: bigint,
  now: Date,
): Promise<void> {
  const tier = effectiveTier(await deps.kyc.find(userId));
  const spent = await deps.payments.sumFiatSince(userId, new Date(now.getTime() - DAY_MS));
  const violation = checkSpendingLimit(tier, amount, spent);
  if (violation?.code === 'kyc_required') {
    throw new AppError('kyc_required', 'Complete identity verification before paying', 403);
  }
  if (violation?.code === 'payment_limit_exceeded') {
    throw new AppError('payment_limit_exceeded', `The limit per payment is ${thb(violation.limit)}`, 422);
  }
  if (violation?.code === 'daily_limit_exceeded') {
    throw new AppError(
      'daily_limit_exceeded',
      `The 24-hour limit is ${thb(violation.limit)}; ${thb(violation.remaining)} remains`,
      422,
    );
  }
}

function thb(minor: bigint): string {
  return `${formatMinor(minor, FIAT_DECIMALS.THB)} THB`;
}
