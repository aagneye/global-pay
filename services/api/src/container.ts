import { parseEther } from 'viem';
import { ViemQuoteSigner } from './adapters/chain/viem-quote-signer.js';
import { ViemSettlementGateway } from './adapters/chain/viem-settlement-gateway.js';
import { ViemTokenReader } from './adapters/chain/viem-token-reader.js';
import { createPrismaClient, createPrismaRepositories } from './adapters/db/prisma-repositories.js';
import { MockKycProvider } from './adapters/kyc/mock-kyc-provider.js';
import { MoonPayOnrampProvider } from './adapters/onramp/moonpay-provider.js';
import { SimulatedOnrampProvider, mintOnLocalChain } from './adapters/onramp/simulated-onramp-provider.js';
import { SimulatedPromptPayProvider } from './adapters/payouts/simulated-promptpay-provider.js';
import { XenditPayoutProvider } from './adapters/payouts/xendit-provider.js';
import { FixedRateProvider } from './adapters/rates/fixed-rate-provider.js';
import { PublicFeedRateProvider } from './adapters/rates/public-feed-rate-provider.js';
import type { Env } from './config/env.js';
import type { PrismaClient } from './generated/prisma/client.js';
import { AccountService } from './modules/account/service.js';
import { AuthService } from './modules/auth/service.js';
import { AccessTokens } from './modules/auth/tokens.js';
import { KycService } from './modules/kyc/service.js';
import { OnrampTracker } from './modules/onramp/onramp-tracker.js';
import { OnrampService } from './modules/onramp/service.js';
import { OpsService } from './modules/ops/service.js';
import { PayoutTracker } from './modules/payouts/payout-tracker.js';
import { PaymentService } from './modules/payments/service.js';
import { QuoteService } from './modules/quotes/service.js';
import type { KycProvider } from './ports/kyc-provider.js';
import type { OnrampProvider } from './ports/onramp-provider.js';
import type { PayoutProvider } from './ports/payout-provider.js';
import type { QuoteSigner } from './ports/quote-signer.js';
import type { RateProvider } from './ports/rate-provider.js';
import type { Repositories } from './ports/repositories.js';
import type { SettlementGateway } from './ports/settlement-gateway.js';
import type { TokenReader } from './ports/token-reader.js';
import { DepositWorker } from './workers/deposit-worker.js';
import { IndexerWorker } from './workers/indexer.js';
import { OnrampWorker } from './workers/onramp-worker.js';
import { PayoutWorker } from './workers/payout-worker.js';

/** Everything that talks to the outside world. Tests replace any of these. */
export interface Adapters {
  repositories: Repositories;
  rates: RateProvider;
  signer: QuoteSigner;
  gateway: SettlementGateway;
  kyc: KycProvider;
  payouts: PayoutProvider;
  onramp: OnrampProvider;
  /** Token transfers on the payment chain (deposits). */
  tokens: TokenReader;
  /** Token transfers where the onramp delivers: the payment chain unless ONRAMP_RPC_URL/ONRAMP_CHAIN_ID say otherwise. */
  onrampTokens: TokenReader;
}

export interface Container {
  tokens: AccessTokens;
  /** OPS_API_TOKEN: without it, the operator console is off. */
  opsToken: string | undefined;
  services: {
    auth: AuthService;
    kyc: KycService;
    quotes: QuoteService;
    payments: PaymentService;
    account: AccountService;
    payouts: PayoutTracker;
    ops: OpsService;
    onramp: OnrampService;
  };
  workers: {
    indexer: IndexerWorker;
    payouts: PayoutWorker;
    onramp: OnrampWorker;
    deposits: DepositWorker;
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
  const payoutProvider = overrides.payouts ?? buildPayoutProvider(env);
  const payoutTracker = new PayoutTracker({
    payouts: repositories.payouts,
    provider: payoutProvider,
    recheckMs: env.PAYOUT_RECHECK_MS,
    pendingDeadlineMs: env.PAYOUT_PENDING_DEADLINE_MS,
  });

  const tokenReader = overrides.tokens ?? new ViemTokenReader({ rpcUrl: env.RPC_URL, chainId: env.CHAIN_ID });
  const onrampChain = { rpcUrl: env.ONRAMP_RPC_URL ?? env.RPC_URL, chainId: env.ONRAMP_CHAIN_ID ?? env.CHAIN_ID };
  const onrampTokens =
    overrides.onrampTokens ?? (env.ONRAMP_RPC_URL || env.ONRAMP_CHAIN_ID ? new ViemTokenReader(onrampChain) : tokenReader);
  const onrampToken = env.ONRAMP_TOKEN_ADDRESS ?? env.USDC_ADDRESS;
  const onrampProvider =
    overrides.onramp ??
    buildOnrampProvider(env, () => new SimulatedOnrampProvider({ rates, deliver: mintOnLocalChain({ ...onrampChain, token: onrampToken }) }));
  const onrampTracker = new OnrampTracker({
    orders: repositories.onrampOrders,
    provider: onrampProvider,
    reader: onrampTokens,
    token: onrampToken,
    confirmations: env.ONRAMP_CONFIRMATIONS ?? env.INDEXER_CONFIRMATIONS,
    recheckMs: env.ONRAMP_RECHECK_MS,
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
    opsToken: env.OPS_API_TOKEN,
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
        payoutRail: payoutProvider,
        payoutFloatBufferMinor: env.PAYOUT_FLOAT_BUFFER_THB,
      }),
      payments,
      payouts: payoutTracker,
      onramp: new OnrampService({
        users: repositories.users,
        orders: repositories.onrampOrders,
        provider: onrampProvider,
        tracker: onrampTracker,
        minFiatMinor: env.ONRAMP_MIN_THB,
        maxFiatMinor: env.ONRAMP_MAX_THB,
        ttlMs: env.ONRAMP_ORDER_TTL_MS,
        maxOpenOrders: env.ONRAMP_MAX_OPEN_ORDERS,
        explorerUrl: env.ONRAMP_EXPLORER_URL ?? env.EXPLORER_URL,
      }),
      ops: new OpsService({
        payments: repositories.payments,
        payouts: repositories.payouts,
        actions: repositories.opsActions,
        tracker: payoutTracker,
        payoutRail: payoutProvider,
        gateway,
        escalateAfterMs: env.OPS_ESCALATE_AFTER_MS,
        refundCooloffMs: env.OPS_REFUND_COOLOFF_MS,
        minRelayerWei: parseEther(env.OPS_MIN_RELAYER_ETH),
        minFloatMinor: env.OPS_MIN_PAYOUT_FLOAT_THB,
      }),
      account: new AccountService({
        users: repositories.users,
        gateway,
        payments,
        usdcAddress: env.USDC_ADDRESS,
        deposits: repositories.deposits,
        onrampOrders: repositories.onrampOrders,
        explorerUrl: env.EXPLORER_URL,
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
        maxBlockRange: env.INDEXER_MAX_BLOCK_RANGE,
      }),
      payouts: new PayoutWorker({
        payments: repositories.payments,
        payouts: repositories.payouts,
        tracker: payoutTracker,
        gateway,
        pollMs: env.PAYOUT_POLL_MS,
        enabled: Boolean(env.SETTLEMENT_ADDRESS && env.RELAYER_PRIVATE_KEY),
      }),
      onramp: new OnrampWorker({ orders: repositories.onrampOrders, tracker: onrampTracker, pollMs: env.ONRAMP_POLL_MS }),
      deposits: new DepositWorker({
        users: repositories.users,
        deposits: repositories.deposits,
        cursors: repositories.cursors,
        reader: tokenReader,
        token: env.USDC_ADDRESS,
        ignoreFrom: env.SETTLEMENT_ADDRESS ? [env.SETTLEMENT_ADDRESS] : [],
        startBlock: env.INDEXER_START_BLOCK,
        confirmations: env.INDEXER_CONFIRMATIONS,
        maxBlockRange: env.INDEXER_MAX_BLOCK_RANGE,
        pollMs: env.DEPOSITS_POLL_MS,
      }),
    },
    async close() {
      await prisma?.$disconnect();
    },
  };
}

/** The payout partner chosen by PAYOUT_PROVIDER. */
function buildPayoutProvider(env: Env): PayoutProvider {
  if (env.PAYOUT_PROVIDER === 'xendit') {
    return new XenditPayoutProvider({
      secretKey: env.XENDIT_SECRET_KEY ?? '',
      baseUrl: env.XENDIT_BASE_URL,
      ...(env.XENDIT_CALLBACK_TOKEN ? { callbackToken: env.XENDIT_CALLBACK_TOKEN } : {}),
      ...(env.XENDIT_PROMPTPAY_CHANNEL ? { promptPayChannelCode: env.XENDIT_PROMPTPAY_CHANNEL } : {}),
      ...(env.PAYOUT_TEST_DESTINATIONS ? { testDestinations: env.PAYOUT_TEST_DESTINATIONS } : {}),
    });
  }
  return new SimulatedPromptPayProvider({
    delayMs: env.PAYOUT_DELAY_MS,
    failureRate: env.PAYOUT_FAILURE_RATE,
    unknownRate: env.PAYOUT_UNKNOWN_RATE,
  });
}

/** The onramp partner chosen by ONRAMP_PROVIDER. */
function buildOnrampProvider(env: Env, simulated: () => OnrampProvider): OnrampProvider {
  if (env.ONRAMP_PROVIDER === 'moonpay') {
    return new MoonPayOnrampProvider({
      publishableKey: env.MOONPAY_PUBLISHABLE_KEY ?? '',
      secretKey: env.MOONPAY_SECRET_KEY ?? '',
      widgetUrl: env.MOONPAY_WIDGET_URL,
      apiUrl: env.MOONPAY_API_URL,
      currencyCode: env.MOONPAY_CURRENCY_CODE,
      ...(env.MOONPAY_WEBHOOK_KEY ? { webhookKey: env.MOONPAY_WEBHOOK_KEY } : {}),
      ...(env.ONRAMP_REDIRECT_URL ? { redirectUrl: env.ONRAMP_REDIRECT_URL } : {}),
    });
  }
  return simulated();
}
