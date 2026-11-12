import {
  type KycStatus,
  type KycTier,
  LIMITS_BY_TIER,
  type SpendingLimits,
  effectiveTier,
} from '../../domain/user.js';
import type { KycProvider, KycSession } from '../../ports/kyc-provider.js';
import type { KycRepository } from '../../ports/repositories.js';

export interface KycServiceDeps {
  provider: KycProvider;
  records: KycRepository;
}

export interface KycView {
  status: KycStatus | 'NOT_STARTED';
  /** The tier in force: 0 until verification is approved. */
  tier: KycTier;
  limits: SpendingLimits;
}

/**
 * Starts verification with the KYC partner and records the resulting tier.
 * Like a real provider, it's two steps: `start` opens a session; `status` picks up the result.
 */
export class KycService {
  private readonly deps: KycServiceDeps;

  constructor(deps: KycServiceDeps) {
    this.deps = deps;
  }

  async start(userId: string): Promise<KycView & { session: KycSession | null }> {
    const existing = await this.deps.records.find(userId);
    if (existing?.status === 'APPROVED') return { ...view(existing.status, existing.tier), session: null };

    const session = await this.deps.provider.startVerification(userId);
    const record = await this.deps.records.save({
      userId,
      provider: this.deps.provider.name,
      status: 'PENDING',
      tier: 0,
    });
    return { ...view(record.status, effectiveTier(record)), session };
  }

  async status(userId: string): Promise<KycView> {
    let record = await this.deps.records.find(userId);
    if (!record) return view('NOT_STARTED', 0);

    if (record.status === 'PENDING') {
      const result = await this.deps.provider.getResult(userId);
      if (result.status !== 'PENDING') {
        record = await this.deps.records.save({
          ...record,
          status: result.status,
          tier: result.tier,
          ...(result.providerRef === undefined ? {} : { providerRef: result.providerRef }),
        });
      }
    }
    return view(record.status, effectiveTier(record));
  }
}

function view(status: KycView['status'], tier: KycTier): KycView {
  return { status, tier, limits: LIMITS_BY_TIER[tier] };
}
