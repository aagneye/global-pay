import type { KycProvider, KycResult, KycSession } from '../../ports/kyc-provider.js';
import { NotImplementedError } from '../../shared/errors.js';

export interface KycServiceDeps {
  provider: KycProvider;
}

/** Starts verification with the KYC partner and records the resulting tier. */
export class KycService {
  private readonly deps: KycServiceDeps;

  constructor(deps: KycServiceDeps) {
    this.deps = deps;
  }

  async start(_userId: string): Promise<KycSession> {
    throw new NotImplementedError('KYC start', 3);
  }

  async status(_userId: string): Promise<KycResult> {
    throw new NotImplementedError('KYC status', 3);
  }
}
