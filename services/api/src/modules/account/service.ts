import type { Address } from 'viem';
import type { Payment } from '../../domain/payment.js';
import type { SettlementGateway } from '../../ports/settlement-gateway.js';
import { NotImplementedError } from '../../shared/errors.js';

export interface AccountServiceDeps {
  gateway: SettlementGateway;
  usdcAddress: Address;
}

/** The signed-in user's balance and payment history. */
export class AccountService {
  private readonly deps: AccountServiceDeps;

  constructor(deps: AccountServiceDeps) {
    this.deps = deps;
  }

  async balance(_userId: string): Promise<{ token: Address; units: bigint }> {
    throw new NotImplementedError('Balance', 4);
  }

  async payments(_userId: string): Promise<Payment[]> {
    throw new NotImplementedError('Payment history', 4);
  }
}
