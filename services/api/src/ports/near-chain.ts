import type { FastifyBaseLogger } from 'fastify';
import type { SettlementGateway } from './settlement-gateway.js';

/** Chain reads the NEAR rail needs beyond the SettlementGateway: building a user's delegate action. */
export interface NearChainReader {
  /** The access key's nonce, or null if the account or key doesn't exist yet. */
  getAccessKeyNonce(accountId: string, publicKey: string): Promise<bigint | null>;
  /** Height of the latest final block. */
  getFinalBlockHeight(): Promise<bigint>;
}

/** The NEAR rail's gateway: the whole payment lifecycle, plus the reads above. */
export interface NearGateway extends SettlementGateway, NearChainReader {}

/** What the services need to know about the NEAR rail (SETTLEMENT_RAIL=near). */
export interface NearRail {
  network: 'testnet' | 'mainnet';
  /** The NEP-141 USDC contract: the delegate action's receiver. */
  usdcContract: string;
  /** The settlement contract: `ft_transfer_call`'s receiver_id. */
  settlementContract: string;
  chain: NearChainReader;
}

/** Testnet onboarding after a NEAR sign-in (fund the account, register it with the token, mint test USDC). */
export interface NearOnboarding {
  /** Never throws: failures are logged. */
  onboard(accountId: string): Promise<void>;
  /** Where to log, once the app's logger exists. */
  useLogger?(log: Pick<FastifyBaseLogger, 'info' | 'warn' | 'error'>): void;
}
