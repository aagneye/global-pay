import type { Address, Hex } from 'viem';
import { TOKEN_DECIMALS } from '../../domain/money.js';
import type { DepositRepository, OnrampOrderRepository, UserRepository } from '../../ports/repositories.js';
import type { SettlementGateway } from '../../ports/settlement-gateway.js';
import { AppError } from '../../shared/errors.js';
import type { PaymentService } from '../payments/service.js';
import type { PaymentView } from '../payments/view.js';

export interface AccountServiceDeps {
  users: UserRepository;
  gateway: SettlementGateway;
  payments: PaymentService;
  usdcAddress: Address;
  deposits: DepositRepository;
  onrampOrders: OnrampOrderRepository;
  explorerUrl: string;
}

/** Money that came in from outside. Amounts are integer strings in token base units. */
export interface DepositView {
  id: string;
  token: Address;
  amount: string;
  from: Address;
  transaction: { hash: Hex; url: string };
  /** Set when the transfer completed one of the user's Add-money orders. */
  onrampOrderId?: string;
  createdAt: string;
}

/** The signed-in user's balance, payments and deposits. */
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

  /** Deposits, newest first, linked to the Add-money order they completed. */
  async deposits(userId: string): Promise<DepositView[]> {
    const [deposits, orders] = await Promise.all([
      this.deps.deposits.listByUser(userId, 50),
      this.deps.onrampOrders.listByUser(userId, 50),
    ]);
    const byTransfer = new Map(
      orders.filter((o) => o.status === 'COMPLETED' && o.txHash).map((o) => [`${o.txHash}:${o.logIndex}`, o.id]),
    );
    const explorer = this.deps.explorerUrl.replace(/\/$/, '');
    return deposits.map((d) => {
      const onrampOrderId = byTransfer.get(`${d.txHash}:${d.logIndex}`);
      return {
        id: d.id,
        token: d.token,
        amount: d.amount.toString(),
        from: d.from,
        transaction: { hash: d.txHash, url: `${explorer}/tx/${d.txHash}` },
        ...(onrampOrderId ? { onrampOrderId } : {}),
        createdAt: d.createdAt.toISOString(),
      };
    });
  }
}
