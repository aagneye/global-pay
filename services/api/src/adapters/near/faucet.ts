import { type Action, actions } from 'near-api-js';
import type { Hex } from 'viem';
import type { NearOnboarding } from '../../ports/near-chain.js';
import type { TxReceipt } from '../../ports/settlement-gateway.js';
import { type WorkerLogger, silentLogger } from '../../workers/loop.js';

/** 0.05 NEAR: creates the implicit account and covers its storage. The relayer pays users' gas. */
export const FAUCET_NEAR_YOCTO = 50_000_000_000_000_000_000_000n;
/** 1,000 test USDC (6 decimals). */
export const FAUCET_USDC_UNITS = 1_000_000_000n;
const FUNCTION_CALL_GAS = 30_000_000_000_000n;

/** What the faucet needs from the relayer (NearSettlementGateway). */
export interface NearRelayerClient {
  accountExists(accountId: string): Promise<boolean>;
  view<T>(contractId: string, methodName: string, args?: object): Promise<T>;
  sendFromRelayer(receiverId: string, txActions: Action[]): Promise<Hex>;
  waitForReceipt(txHash: Hex): Promise<TxReceipt>;
}

export interface NearTestnetFaucetOptions {
  relayer: NearRelayerClient;
  /** The test USDC contract; the relayer must be its minter (`new({owner_id, minter_id: relayer})`). */
  usdcContract: string;
  fundYocto?: bigint;
  mintUnits?: bigint;
}

/**
 * Testnet onboarding (NEAR_TESTNET_FAUCET=true), at each NEAR sign-in, doing only what's missing:
 * 1. the account doesn't exist: the relayer sends it 0.05 NEAR, which creates the implicit account;
 * 2. it isn't registered with the test USDC: `storage_deposit` for it, then `mint` 1,000 USDC (the relayer
 *    is the token's minter), in one transaction.
 * A user who already has both gets nothing. Failures are logged, never thrown: signing in still works.
 */
export class NearTestnetFaucet implements NearOnboarding {
  private readonly options: Required<NearTestnetFaucetOptions>;
  private readonly running = new Map<string, Promise<void>>();
  private log: WorkerLogger = silentLogger;

  constructor(options: NearTestnetFaucetOptions) {
    this.options = { fundYocto: FAUCET_NEAR_YOCTO, mintUnits: FAUCET_USDC_UNITS, ...options };
  }

  /** Where failures go (the app's logger, once it exists). */
  useLogger(log: WorkerLogger): void {
    this.log = log;
  }

  onboard(accountId: string): Promise<void> {
    const running = this.running.get(accountId);
    if (running) return running;
    const run = this.run(accountId)
      .catch((error: unknown) => this.log.warn({ err: error, accountId }, 'testnet onboarding failed'))
      .finally(() => this.running.delete(accountId));
    this.running.set(accountId, run);
    return run;
  }

  private async run(accountId: string): Promise<void> {
    const { relayer, usdcContract, fundYocto, mintUnits } = this.options;
    if (!(await relayer.accountExists(accountId))) {
      await this.send(accountId, [actions.transfer(fundYocto)], 'create account');
    }
    const registered = await relayer.view<unknown>(usdcContract, 'storage_balance_of', { account_id: accountId });
    if (registered) return;
    const bounds = await relayer.view<{ min: string }>(usdcContract, 'storage_balance_bounds');
    await this.send(
      usdcContract,
      [
        actions.functionCall('storage_deposit', { account_id: accountId, registration_only: true }, FUNCTION_CALL_GAS, BigInt(bounds.min)),
        actions.functionCall('mint', { account_id: accountId, amount: mintUnits.toString() }, FUNCTION_CALL_GAS, 0n),
      ],
      'register and mint',
    );
    this.log.info({ accountId, units: mintUnits.toString() }, 'testnet account funded with test USDC');
  }

  private async send(receiverId: string, txActions: Action[], step: string): Promise<void> {
    const hash = await this.options.relayer.sendFromRelayer(receiverId, txActions);
    const receipt = await this.options.relayer.waitForReceipt(hash);
    if (receipt.status !== 'success') throw new Error(`testnet onboarding: ${step} transaction ${hash} failed`);
  }
}
