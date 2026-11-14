import { type Address, type Hex, createWalletClient, defineChain, http, parseAbi } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { FIAT_DECIMALS, TOKEN_DECIMALS } from '../../domain/money.js';
import type { OnrampCheckout, OnrampProvider, OnrampResult } from '../../ports/onramp-provider.js';
import type { RateProvider } from '../../ports/rate-provider.js';
import { AppError } from '../../shared/errors.js';

/** Sends `amount` token base units to `to`; returns the transaction hash. */
export type Deliver = (to: Address, amount: bigint) => Promise<Hex>;

interface Purchase {
  checkout: OnrampCheckout;
  status: OnrampResult['status'];
  tokenAmount?: bigint;
  txHash?: Hex;
  failureReason?: string;
}

/**
 * Stand-in for MoonPay in local development and tests. Its "checkout" is a page on our own API
 * (/onramp/simulator/:orderId) with a pay button; paying sends test USDC with `deliver`, so the order
 * is proved on-chain exactly like a real one. Purchases live in memory: a restart forgets them, and
 * their orders then expire.
 */
export class SimulatedOnrampProvider implements OnrampProvider {
  readonly name = 'simulated-onramp';
  private readonly purchases = new Map<string, Purchase>();

  constructor(private readonly deps: { rates: RateProvider; deliver: Deliver }) {}

  checkoutUrl(checkout: OnrampCheckout): string {
    if (!this.purchases.has(checkout.orderId)) this.purchases.set(checkout.orderId, { checkout, status: 'waiting' });
    return `/onramp/simulator/${encodeURIComponent(checkout.orderId)}`;
  }

  async findByOrderId(orderId: string): Promise<OnrampResult | null> {
    const purchase = this.purchases.get(orderId);
    return purchase ? this.toResult(orderId, purchase) : null;
  }

  /** The order's checkout, for the simulator page; undefined if this run never made it. */
  checkout(orderId: string): OnrampCheckout | undefined {
    return this.purchases.get(orderId)?.checkout;
  }

  /** "Pays by card": prices the baht at the current rate and sends the USDC. */
  async pay(orderId: string): Promise<OnrampResult> {
    const purchase = this.require(orderId);
    if (purchase.status !== 'waiting') return this.toResult(orderId, purchase);
    const rate = await this.deps.rates.getRate('USDC', 'THB');
    // THB satang → USDC base units at rateE8 THB per USDC, rounded down.
    const scale = 10n ** BigInt(TOKEN_DECIMALS.USDC - FIAT_DECIMALS.THB) * 100_000_000n;
    purchase.tokenAmount = (purchase.checkout.fiat.minor * scale) / rate.rateE8;
    purchase.status = 'pending';
    purchase.txHash = await this.deps.deliver(purchase.checkout.walletAddress, purchase.tokenAmount);
    purchase.status = 'completed';
    return this.toResult(orderId, purchase);
  }

  /** "The card is declined." */
  decline(orderId: string): OnrampResult {
    const purchase = this.require(orderId);
    if (purchase.status === 'waiting') {
      purchase.status = 'failed';
      purchase.failureReason = 'Card declined (simulated)';
    }
    return this.toResult(orderId, purchase);
  }

  private require(orderId: string): Purchase {
    const purchase = this.purchases.get(orderId);
    if (!purchase) throw new AppError('not_found', 'No such simulated purchase (the API may have restarted)', 404);
    return purchase;
  }

  private toResult(orderId: string, purchase: Purchase): OnrampResult {
    return {
      status: purchase.status,
      providerTxId: `sim_${orderId}`,
      providerStatus: purchase.status,
      walletAddress: purchase.checkout.walletAddress,
      ...(purchase.tokenAmount === undefined ? {} : { tokenAmount: purchase.tokenAmount }),
      ...(purchase.txHash ? { txHash: purchase.txHash } : {}),
      ...(purchase.failureReason ? { failureReason: purchase.failureReason } : {}),
    };
  }
}

/** Anvil's account #9: a public test key, used only to mint mock USDC on a local chain. */
const ANVIL_MINTER_KEY: Hex = '0x2a871d0798f97d79848a013d4936a73bf4cc922c825d33c1cf7073dff6d409c6';
const LOCAL_CHAIN_ID = 31337;

/**
 * Delivers by minting the local chain's mock USDC (contracts/test/mocks/MockUSDC3009.sol, whose mint is
 * open). Refuses any chain but anvil's.
 */
export function mintOnLocalChain(options: { rpcUrl: string; chainId: number; token: Address }): Deliver {
  return async (to, amount) => {
    if (options.chainId !== LOCAL_CHAIN_ID) {
      throw new AppError('not_configured', 'The simulated onramp only delivers on a local chain (anvil); use MoonPay', 503);
    }
    const wallet = createWalletClient({
      account: privateKeyToAccount(ANVIL_MINTER_KEY),
      chain: defineChain({
        id: LOCAL_CHAIN_ID,
        name: 'anvil',
        nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
        rpcUrls: { default: { http: [options.rpcUrl] } },
      }),
      transport: http(options.rpcUrl),
    });
    return wallet.writeContract({
      address: options.token,
      abi: parseAbi(['function mint(address to, uint256 amount)']),
      functionName: 'mint',
      args: [to, amount],
    });
  };
}
