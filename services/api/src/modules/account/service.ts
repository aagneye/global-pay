import type { Address } from 'viem';
import { TOKEN_DECIMALS } from '../../domain/money.js';
import type { UserRepository } from '../../ports/repositories.js';
import type { SettlementGateway } from '../../ports/settlement-gateway.js';
import { AppError } from '../../shared/errors.js';
import type { PaymentService } from '../payments/service.js';
import type { PaymentView } from '../payments/view.js';

export interface AccountServiceDeps {
  users: UserRepository;
  gateway: SettlementGateway;
  payments: PaymentService;
  usdcAddress: Address;
}

/** The signed-in user's balance and payment history. */
export class AccountService {
  private readonly deps: AccountServiceDeps;

  constructor(deps: AccountServiceDeps) {
    this.deps = deps;
  }

  /** USDC in the user's wallet, read from the chain. */
  async balance(userId: string): Promise<{ token: Address; units: bigint; decimals: number }> {
    const user = await this.deps.users.findById(userId);
    if (!user) throw new AppError('unauthorized', 'Unknown user; sign in again', 401);
    const units = await this.deps.gateway.getTokenBalance(this.deps.usdcAddress, user.walletAddress);
    return { token: this.deps.usdcAddress, units, decimals: TOKEN_DECIMALS.USDC };
  }

  async payments(userId: string): Promise<PaymentView[]> {
    return this.deps.payments.list(userId);
  }
}
