import { ViemQuoteSigner } from './adapters/chain/viem-quote-signer.js';
import { ViemSettlementGateway } from './adapters/chain/viem-settlement-gateway.js';
import { MockKycProvider } from './adapters/kyc/mock-kyc-provider.js';
import { SimulatedPromptPayProvider } from './adapters/payouts/simulated-promptpay-provider.js';
import { PublicFeedRateProvider } from './adapters/rates/public-feed-rate-provider.js';
import type { Env } from './config/env.js';
import { AccountService } from './modules/account/service.js';
import { AuthService } from './modules/auth/service.js';
import { KycService } from './modules/kyc/service.js';
import { PaymentService } from './modules/payments/service.js';
import { QuoteService } from './modules/quotes/service.js';
import { IndexerWorker } from './workers/indexer.js';
import { PayoutWorker } from './workers/payout-worker.js';

export interface Container {
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
}

/**
 * Composition root: the only place that chooses adapters.
 * To swap a simulated partner for a real one, change it here and nowhere else.
 */
export function buildContainer(env: Env): Container {
  const gateway = new ViemSettlementGateway({
    rpcUrl: env.RPC_URL,
    chainId: env.CHAIN_ID,
    settlementAddress: env.SETTLEMENT_ADDRESS,
    relayerPrivateKey: env.RELAYER_PRIVATE_KEY,
  });
  const signer = new ViemQuoteSigner({
    privateKey: env.QUOTE_SIGNER_PRIVATE_KEY,
    chainId: env.CHAIN_ID,
    settlementAddress: env.SETTLEMENT_ADDRESS,
  });
  const kycProvider = new MockKycProvider();
  const rates = new PublicFeedRateProvider();
  const payoutProvider = new SimulatedPromptPayProvider({
    delayMs: env.PAYOUT_DELAY_MS,
    failureRate: env.PAYOUT_FAILURE_RATE,
  });

  return {
    services: {
      auth: new AuthService({ jwtSecret: env.JWT_SECRET, chainId: env.CHAIN_ID }),
      kyc: new KycService({ provider: kycProvider }),
      quotes: new QuoteService({
        rates,
        signer,
        kyc: kycProvider,
        gateway,
        usdcAddress: env.USDC_ADDRESS,
        quoteTtlSeconds: env.QUOTE_TTL_SECONDS,
        spreadBps: env.SPREAD_BPS,
        merchantQrOnly: env.MERCHANT_QR_ONLY,
      }),
      payments: new PaymentService({ gateway }),
      account: new AccountService({ gateway, usdcAddress: env.USDC_ADDRESS }),
    },
    workers: {
      indexer: new IndexerWorker({
        gateway,
        pollMs: env.INDEXER_POLL_MS,
        confirmations: env.INDEXER_CONFIRMATIONS,
      }),
      payouts: new PayoutWorker({ payouts: payoutProvider, gateway, pollMs: env.INDEXER_POLL_MS }),
    },
  };
}
