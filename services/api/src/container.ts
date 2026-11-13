import { ViemQuoteSigner } from './adapters/chain/viem-quote-signer.js';
import { ViemSettlementGateway } from './adapters/chain/viem-settlement-gateway.js';
import { createPrismaClient, createPrismaRepositories } from './adapters/db/prisma-repositories.js';
import { MockKycProvider } from './adapters/kyc/mock-kyc-provider.js';
import { SimulatedPromptPayProvider } from './adapters/payouts/simulated-promptpay-provider.js';
import { FixedRateProvider } from './adapters/rates/fixed-rate-provider.js';
import { PublicFeedRateProvider } from './adapters/rates/public-feed-rate-provider.js';
import type { Env } from './config/env.js';
import type { PrismaClient } from './generated/prisma/client.js';
import { AccountService } from './modules/account/service.js';
import { AuthService } from './modules/auth/service.js';
import { AccessTokens } from './modules/auth/tokens.js';
import { KycService } from './modules/kyc/service.js';
import { PayoutTracker } from './modules/payouts/payout-tracker.js';
import { PaymentService } from './modules/payments/service.js';
import { QuoteService } from './modules/quotes/service.js';
import type { KycProvider } from './ports/kyc-provider.js';
import type { PayoutProvider } from './ports/payout-provider.js';
import type { QuoteSigner } from './ports/quote-signer.js';
import type { RateProvider } from './ports/rate-provider.js';
import type { Repositories } from './ports/repositories.js';
import type { SettlementGateway } from './ports/settlement-gateway.js';
import { IndexerWorker } from './workers/indexer.js';
import { PayoutWorker } from './workers/payout-worker.js';

/** Everything that talks to the outside world. Tests replace any of these. */
export interface Adapters {
  repositories: Repositories;
  rates: RateProvider;
  signer: QuoteSigner;
  gateway: SettlementGateway;
  kyc: KycProvider;
  payouts: PayoutProvider;
}

export interface Container {
  tokens: AccessTokens;
  services: {
    auth: AuthService;
    kyc: KycService;
    quotes: QuoteService;
    payments: PaymentService;
    account: AccountService;
  };
  workers: {
    indexer: IndexerWorker;
    payouts: PayoutWorker;
  };
  /** Releases connections (database). */
  close(): Promise<void>;
}

/**
 * Composition root: the only place that chooses adapters.
 * To swap a simulated partner for a real one, change it here and nowhere else.
 */
export function buildContainer(env: Env, overrides: Partial<Adapters> = {}): Container {
  let prisma: PrismaClient | undefined;
  let repositories = overrides.repositories;
  if (!repositories) {
    prisma = createPrismaClient(env.DATABASE_URL, env.DATABASE_POOL_SIZE);
    repositories = createPrismaRepositories(prisma);
  }

  const gateway =
    overrides.gateway ??
    new ViemSettlementGateway({
      rpcUrl: env.RPC_URL,
      chainId: env.CHAIN_ID,
      settlementAddress: env.SETTLEMENT_ADDRESS,
      relayerPrivateKey: env.RELAYER_PRIVATE_KEY,
      pollingIntervalMs: env.CHAIN_POLL_MS,
    });
  const signer =
    overrides.signer ??
    new ViemQuoteSigner({
      privateKey: env.QUOTE_SIGNER_PRIVATE_KEY,
      chainId: env.CHAIN_ID,
      settlementAddress: env.SETTLEMENT_ADDRESS,
    });
  const kycProvider = overrides.kyc ?? new MockKycProvider();
  const rates =
    overrides.rates ??
    (env.RATE_SOURCE === 'fixed' ? new FixedRateProvider(env.FIXED_USDC_THB_RATE) : new PublicFeedRateProvider());
  const payoutProvider =
    overrides.payouts ??
    new SimulatedPromptPayProvider({
      delayMs: env.PAYOUT_DELAY_MS,
      failureRate: env.PAYOUT_FAILURE_RATE,
      unknownRate: env.PAYOUT_UNKNOWN_RATE,
    });
  const payoutTracker = new PayoutTracker({
    payouts: repositories.payouts,
    provider: payoutProvider,
    recheckMs: env.PAYOUT_RECHECK_MS,
    pendingDeadlineMs: env.PAYOUT_PENDING_DEADLINE_MS,
  });

  const tokens = new AccessTokens({ secret: env.JWT_SECRET, ttlSeconds: env.JWT_TTL_SECONDS });
  const payments = new PaymentService({
    quotes: repositories.quotes,
    payments: repositories.payments,
    kyc: repositories.kyc,
    gateway,
    chainId: env.CHAIN_ID,
    settlementAddress: env.SETTLEMENT_ADDRESS,
    explorerUrl: env.EXPLORER_URL,
  });

  return {
    tokens,
    services: {
      auth: new AuthService({
        users: repositories.users,
        nonces: repositories.nonces,
        tokens,
        chainId: env.CHAIN_ID,
        domain: env.SIWE_DOMAIN,
      }),
      kyc: new KycService({ provider: kycProvider, records: repositories.kyc }),
      quotes: new QuoteService({
        users: repositories.users,
        kyc: repositories.kyc,
        payments: repositories.payments,
        quotes: repositories.quotes,
        rates,
        signer,
        gateway,
        chainId: env.CHAIN_ID,
        usdcAddress: env.USDC_ADDRESS,
        settlementAddress: env.SETTLEMENT_ADDRESS,
        quoteTtlSeconds: env.QUOTE_TTL_SECONDS,
        spreadBps: env.SPREAD_BPS,
        merchantQrOnly: env.MERCHANT_QR_ONLY,
      }),
      payments,
      account: new AccountService({
        users: repositories.users,
        gateway,
        payments,
        usdcAddress: env.USDC_ADDRESS,
      }),
    },
    workers: {
      indexer: new IndexerWorker({
        gateway,
        payments: repositories.payments,
        quotes: repositories.quotes,
        cursors: repositories.cursors,
        chainId: env.CHAIN_ID,
        settlementAddress: env.SETTLEMENT_ADDRESS,
        pollMs: env.INDEXER_POLL_MS,
        confirmations: env.INDEXER_CONFIRMATIONS,
        startBlock: env.INDEXER_START_BLOCK,
      }),
      payouts: new PayoutWorker({
        payments: repositories.payments,
        payouts: repositories.payouts,
        tracker: payoutTracker,
        gateway,
        pollMs: env.PAYOUT_POLL_MS,
        enabled: Boolean(env.SETTLEMENT_ADDRESS && env.RELAYER_PRIVATE_KEY),
      }),
    },
    async close() {
      await prisma?.$disconnect();
    },
  };
}

