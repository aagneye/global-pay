import { z } from 'zod';
import { FIAT_DECIMALS, RATE_DECIMALS, TOKEN_DECIMALS, parseDecimal } from '../domain/money.js';
import { addressSchema, nearAccountIdSchema, nearPrivateKeySchema, privateKeySchema } from '../shared/schemas.js';
import { ANVIL_CHAIN_ID, isPublicTestKey } from './public-test-keys.js';

/** A fixed exchange rate like "35.00" (fiat per 1 USDC), as rateE8. */
function fixedRate(name: string, fallback: string) {
  return z
    .string()
    .default(fallback)
    .transform((value, ctx) => {
      const rateE8 = parseDecimal(value, RATE_DECIMALS);
      if (rateE8 === null || rateE8 <= 0n) {
        ctx.addIssue({ code: 'custom', message: `${name} must be a positive decimal, e.g. ${fallback}` });
        return z.NEVER;
      }
      return rateE8;
    });
}

/** A THB amount like "5000" or "5000.00", as satang. */
function thbAmount(name: string, fallback: string) {
  return z
    .string()
    .default(fallback)
    .transform((value, ctx) => {
      const minor = parseDecimal(value, FIAT_DECIMALS.THB);
      if (minor === null) {
        ctx.addIssue({ code: 'custom', message: `${name} must be a THB amount, e.g. 5000 or 5000.00` });
        return z.NEVER;
      }
      return minor;
    });
}

const testDestinationsSchema = z.record(
  z.string(),
  z.object({ channelCode: z.string(), accountNumber: z.string(), accountHolderName: z.string() }),
);

export const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  HOST: z.string().default('0.0.0.0'),
  PORT: z.coerce.number().int().positive().default(3000),
  /**
   * Proxies trusted to report the client's IP (X-Forwarded-For), which rate limits key on.
   * Unset: none (clients connect directly). A hop count (e.g. 1 behind one load balancer), or the proxies'
   * addresses/CIDRs, comma-separated. `true` trusts any X-Forwarded-For, which clients can forge.
   */
  TRUST_PROXY: z
    .string()
    .optional()
    .transform((value): boolean | number | string[] => {
      if (value === undefined || value === 'false') return false;
      if (value === 'true') return true;
      if (/^\d+$/.test(value)) return Number(value);
      return value.split(',').map((item) => item.trim()).filter(Boolean);
    }),

  /** The largest request body accepted, in bytes (64 KiB). Bigger ones get 413. */
  BODY_LIMIT_BYTES: z.coerce.number().int().min(1_024).max(10 * 1024 * 1024).default(64 * 1024),

  // Rate limits: requests per RATE_LIMIT_WINDOW_MS. Each limited route has its own budget.
  RATE_LIMIT_ENABLED: z.stringbool().default(true),
  RATE_LIMIT_WINDOW_MS: z.coerce.number().int().min(1_000).default(60_000),
  /** Any route without its own limit, per IP (shared by those routes). */
  RATE_LIMIT_MAX: z.coerce.number().int().min(1).default(600),
  /** POST /auth/nonce and /auth/verify, per IP. */
  RATE_LIMIT_AUTH_MAX: z.coerce.number().int().min(1).default(30),
  /** POST /quotes and POST /payments, per signed-in user (else IP). */
  RATE_LIMIT_PAYMENTS_MAX: z.coerce.number().int().min(1).default(30),
  /** POST /onramp/orders, per signed-in user (else IP). */
  RATE_LIMIT_ONRAMP_MAX: z.coerce.number().int().min(1).default(10),
  /** Tap-to-pay request, tap, claim and approve, per signed-in user (else IP). */
  RATE_LIMIT_P2P_MAX: z.coerce.number().int().min(1).default(30),
  /** POST /devices, per signed-in user (else IP). */
  RATE_LIMIT_DEVICES_MAX: z.coerce.number().int().min(1).default(10),
  /** Partner webhooks, per IP. Generous: partners retry and burst. */
  RATE_LIMIT_WEBHOOKS_MAX: z.coerce.number().int().min(1).default(1_200),
  /** The operator API (/ops/api/*), per IP. */
  RATE_LIMIT_OPS_MAX: z.coerce.number().int().min(1).default(120),

  DATABASE_URL: z.string().min(1),
  /** Connections to Postgres. Set 1 with `prisma dev`, which can only serve one at a time. */
  DATABASE_POOL_SIZE: z.coerce.number().int().min(1).max(100).optional(),

  JWT_SECRET: z.string().min(32, 'JWT_SECRET must be at least 32 characters'),
  JWT_TTL_SECONDS: z.coerce.number().int().min(300).max(7 * 24 * 3600).default(24 * 3600),
  /** EIP-4361 domain that sign-in messages must name. */
  SIWE_DOMAIN: z
    .string()
    .regex(/^[a-z0-9.-]+(?::\d+)?$/i, 'SIWE_DOMAIN must be a host name, e.g. globalpay.local')
    .default('globalpay.local'),

  CHAIN_ID: z.coerce.number().int().positive().default(84532),
  RPC_URL: z.url(),
  /** How often to poll the node for receipts. Base makes a block every 2 s. */
  CHAIN_POLL_MS: z.coerce.number().int().min(50).default(1_000),
  EXPLORER_URL: z.url().default('https://sepolia.basescan.org'),
  USDC_ADDRESS: addressSchema,
  SETTLEMENT_ADDRESS: addressSchema.optional(),

  QUOTE_SIGNER_PRIVATE_KEY: privateKeySchema.optional(),
  RELAYER_PRIVATE_KEY: privateKeySchema.optional(),

  /**
   * Which chain settles payments, one per backend: `evm` (CHAIN_ID, USDC_ADDRESS, SETTLEMENT_ADDRESS and the
   * keys above) or `near` (the NEAR_* settings). Tap to pay, Add money and deposits are EVM only.
   */
  SETTLEMENT_RAIL: z.enum(['evm', 'near']).default('evm'),

  // NEAR rail (SETTLEMENT_RAIL=near)
  NEAR_NETWORK: z.enum(['testnet', 'mainnet']).default('testnet'),
  NEAR_RPC_URL: z.url().default('https://test.rpc.fastnear.com'),
  /** The GlobalPay settlement contract's account. */
  NEAR_SETTLEMENT_CONTRACT: nearAccountIdSchema.optional(),
  /** The NEP-141 USDC contract's account. */
  NEAR_USDC_CONTRACT: nearAccountIdSchema.optional(),
  /** Pays the gas for users' meta transactions, and is the settlement contract's operator (settle, refund). */
  NEAR_RELAYER_ACCOUNT_ID: nearAccountIdSchema.optional(),
  /** "ed25519:..." full-access key of NEAR_RELAYER_ACCOUNT_ID. */
  NEAR_RELAYER_PRIVATE_KEY: nearPrivateKeySchema.optional(),
  /** "ed25519:..." key whose public key the settlement contract trusts to sign quotes. */
  NEAR_QUOTE_SIGNER_PRIVATE_KEY: nearPrivateKeySchema.optional(),
  /** Where settled USDC goes (set in the contract; shown by `npm run near:testnet -- status`). */
  NEAR_TREASURY_ACCOUNT_ID: nearAccountIdSchema.optional(),
  /**
   * Testnet only: on a NEAR user's first sign-in, the relayer creates their account with 0.05 NEAR,
   * registers it with the token and mints 1,000 test USDC (the relayer must be the test token's minter).
   */
  NEAR_TESTNET_FAUCET: z.stringbool().default(false),
  NEAR_EXPLORER_URL: z.url().default('https://testnet.nearblocks.io'),

  QUOTE_TTL_SECONDS: z.coerce.number().int().min(15).max(300).default(60),
  SPREAD_BPS: z.coerce.number().int().min(0).max(1_000).default(100),
  MERCHANT_QR_ONLY: z.stringbool().default(false),

  /** `public`: Coinbase's public USDC rates. `fixed`: FIXED_USDC_THB_RATE and FIXED_USDC_INR_RATE (offline development and tests). */
  RATE_SOURCE: z.enum(['public', 'fixed']).default('public'),
  /** THB per 1 USDC, as a decimal. Becomes rateE8. */
  FIXED_USDC_THB_RATE: fixedRate('FIXED_USDC_THB_RATE', '35.00'),
  /** INR per 1 USDC, as a decimal (card terminal charges). Becomes rateE8. */
  FIXED_USDC_INR_RATE: fixedRate('FIXED_USDC_INR_RATE', '88.00'),

  /** `simulated`: no money moves (local and tests). `xendit`: Xendit payouts (sandbox first). */
  PAYOUT_PROVIDER: z.enum(['simulated', 'xendit']).default('simulated'),
  PAYOUT_POLL_MS: z.coerce.number().int().min(200).default(2_000),
  /** How often to ask the partner about a pending payout. */
  PAYOUT_RECHECK_MS: z.coerce.number().int().min(0).default(5_000),
  /** A payout still pending after this long becomes UNKNOWN. */
  PAYOUT_PENDING_DEADLINE_MS: z.coerce.number().int().min(60_000).default(30 * 60_000),
  /** Refuse quotes when the partner's float minus the amount would go below this (THB). */
  PAYOUT_FLOAT_BUFFER_THB: thbAmount('PAYOUT_FLOAT_BUFFER_THB', '0'),

  // Simulated partner
  PAYOUT_DELAY_MS: z.coerce.number().int().min(0).default(3_000),
  /** 0..1. Set to 1 to force failures and exercise refunds. */
  PAYOUT_FAILURE_RATE: z.coerce.number().min(0).max(1).default(0),
  /** 0..1. Set to 1 to make every outcome unclear and exercise the operator flow. */
  PAYOUT_UNKNOWN_RATE: z.coerce.number().min(0).max(1).default(0),

  // Xendit
  XENDIT_SECRET_KEY: z.string().min(1).optional(),
  XENDIT_CALLBACK_TOKEN: z.string().min(1).optional(),
  XENDIT_BASE_URL: z.url().default('https://api.xendit.co'),
  /** Xendit's THB channel for PromptPay IDs, from GET /payouts_channels?currency=THB. */
  XENDIT_PROMPTPAY_CHANNEL: z.string().min(1).optional(),
  /**
   * Sandbox only: JSON map from PromptPay target ID to a Xendit test destination,
   * e.g. {"099999999999901":{"channelCode":"TH_KBANK","accountNumber":"...","accountHolderName":"..."}}.
   */
  PAYOUT_TEST_DESTINATIONS: z
    .string()
    .optional()
    .transform((value, ctx) => {
      if (value === undefined) return undefined;
      try {
        return testDestinationsSchema.parse(JSON.parse(value));
      } catch {
        ctx.addIssue({ code: 'custom', message: 'PAYOUT_TEST_DESTINATIONS must be a JSON map of destinations' });
        return z.NEVER;
      }
    }),

  // Operations
  /** Bearer token for /ops (at least 32 characters). Without it, /ops is off. */
  OPS_API_TOKEN: z.string().min(32, 'OPS_API_TOKEN must be at least 32 characters').optional(),
  /** An UNKNOWN payout older than this is shown as needing an operator. */
  OPS_ESCALATE_AFTER_MS: z.coerce.number().int().min(0).default(30 * 60_000),
  /** An operator can approve a refund only after the payout has been UNKNOWN this long. */
  OPS_REFUND_COOLOFF_MS: z.coerce.number().int().min(0).default(60 * 60_000),
  /** A transaction (settle, refund, tap-to-pay transfer) without a receipt after this long is shown as stuck. */
  OPS_STUCK_TX_AFTER_MS: z.coerce.number().int().min(0).default(10 * 60_000),
  /** Alert when the relayer has less than this much ETH. */
  OPS_MIN_RELAYER_ETH: z.string().regex(/^\d+(\.\d+)?$/).default('0.005'),
  /** Alert when the payout float is below this (THB). */
  OPS_MIN_PAYOUT_FLOAT_THB: thbAmount('OPS_MIN_PAYOUT_FLOAT_THB', '0'),

  // Add money (onramp). `simulated`: a local checkout page that mints test USDC on anvil. `moonpay`: MoonPay.
  ONRAMP_PROVIDER: z.enum(['simulated', 'moonpay']).default('simulated'),
  /** MoonPay's minimum for THB is 800. */
  ONRAMP_MIN_THB: thbAmount('ONRAMP_MIN_THB', '800'),
  ONRAMP_MAX_THB: thbAmount('ONRAMP_MAX_THB', '50000'),
  /** An order nobody paid for expires after this long. */
  ONRAMP_ORDER_TTL_MS: z.coerce.number().int().min(60_000).default(60 * 60_000),
  ONRAMP_MAX_OPEN_ORDERS: z.coerce.number().int().min(1).default(3),
  ONRAMP_POLL_MS: z.coerce.number().int().min(200).default(5_000),
  /** How often to ask the partner about an open order. */
  ONRAMP_RECHECK_MS: z.coerce.number().int().min(0).default(15_000),
  /** Where the partner delivers, if not the payment chain (MoonPay's sandbox delivers on Ethereum Sepolia). */
  ONRAMP_RPC_URL: z.url().optional(),
  ONRAMP_CHAIN_ID: z.coerce.number().int().positive().optional(),
  ONRAMP_TOKEN_ADDRESS: addressSchema.optional(),
  ONRAMP_EXPLORER_URL: z.url().optional(),
  /** Blocks to wait after the delivering transfer; defaults to INDEXER_CONFIRMATIONS. */
  ONRAMP_CONFIRMATIONS: z.coerce.number().int().min(0).optional(),
  /** Where the widget sends the user afterwards: an https link back to the app (optional). */
  ONRAMP_REDIRECT_URL: z.url().optional(),

  // MoonPay
  MOONPAY_PUBLISHABLE_KEY: z.string().min(1).optional(),
  MOONPAY_SECRET_KEY: z.string().min(1).optional(),
  MOONPAY_WEBHOOK_KEY: z.string().min(1).optional(),
  MOONPAY_WIDGET_URL: z.url().default('https://buy-sandbox.moonpay.com'),
  MOONPAY_API_URL: z.url().default('https://api.moonpay.com'),
  MOONPAY_CURRENCY_CODE: z.string().min(1).default('usdc_base'),

  // Tap to pay (person to person)
  /** The sender must approve within this. */
  P2P_REQUEST_TTL_MS: z.coerce.number().int().min(30_000).default(120_000),
  /** EIP-3009 validBefore, from the request's creation. */
  P2P_AUTHORIZATION_TTL_MS: z.coerce.number().int().min(60_000).default(600_000),
  /** The most one request may ask for, in USDC. */
  P2P_MAX_AMOUNT_USDC: z
    .string()
    .default('1000')
    .transform((value, ctx) => {
      const units = parseDecimal(value, TOKEN_DECIMALS.USDC);
      if (units === null || units <= 0n) {
        ctx.addIssue({ code: 'custom', message: 'P2P_MAX_AMOUNT_USDC must be a positive USDC amount' });
        return z.NEVER;
      }
      return units;
    }),
  /** The most one sender may send by tap to pay in any 24 hours, in USDC. */
  P2P_DAILY_LIMIT_USDC: z
    .string()
    .default('2000')
    .transform((value, ctx) => {
      const units = parseDecimal(value, TOKEN_DECIMALS.USDC);
      if (units === null || units <= 0n) {
        ctx.addIssue({ code: 'custom', message: 'P2P_DAILY_LIMIT_USDC must be a positive USDC amount' });
        return z.NEVER;
      }
      return units;
    }),
  P2P_MAX_OPEN_REQUESTS: z.coerce.number().int().min(1).default(3),
  /** Requests waiting for one sender's approval: stops a stranger spamming someone with taps. */
  P2P_MAX_AWAITING_PER_SENDER: z.coerce.number().int().min(1).default(3),
  P2P_POLL_MS: z.coerce.number().int().min(200).default(2_000),
  /** A Google service-account key file (JSON) with Firebase Cloud Messaging access. Without it, no push. */
  FCM_SERVICE_ACCOUNT_FILE: z.string().min(1).optional(),

  /** How often to look for USDC arriving in users' wallets. */
  DEPOSITS_POLL_MS: z.coerce.number().int().min(200).default(10_000),

  INDEXER_POLL_MS: z.coerce.number().int().min(200).default(4_000),
  INDEXER_CONFIRMATIONS: z.coerce.number().int().min(0).default(2),
  /** First block to index: the settlement contract's deployment block. */
  INDEXER_START_BLOCK: z.coerce.bigint().nonnegative().default(0n),
  /** Blocks per log query. Base's public RPCs allow 200; providers usually allow more. */
  INDEXER_MAX_BLOCK_RANGE: z.coerce.bigint().positive().default(200n),
});

export type Env = z.infer<typeof envSchema>;

/** What the NEAR rail can't run without. */
const NEAR_RAIL_REQUIRED = [
  'NEAR_SETTLEMENT_CONTRACT',
  'NEAR_USDC_CONTRACT',
  'NEAR_RELAYER_ACCOUNT_ID',
  'NEAR_RELAYER_PRIVATE_KEY',
  'NEAR_QUOTE_SIGNER_PRIVATE_KEY',
] as const;

/** Settings that only make sense together. */
function checkCombinations(env: Env, ctx: z.RefinementCtx): void {
  if (env.PAYOUT_PROVIDER === 'xendit' && !env.XENDIT_SECRET_KEY) {
    ctx.addIssue({ code: 'custom', path: ['XENDIT_SECRET_KEY'], message: 'PAYOUT_PROVIDER=xendit needs XENDIT_SECRET_KEY' });
  }
  if (env.NODE_ENV === 'production' && env.PAYOUT_TEST_DESTINATIONS) {
    ctx.addIssue({
      code: 'custom',
      path: ['PAYOUT_TEST_DESTINATIONS'],
      message: 'PAYOUT_TEST_DESTINATIONS is for the sandbox and is refused in production',
    });
  }
  if (env.NODE_ENV === 'production' && env.PAYOUT_PROVIDER === 'simulated') {
    ctx.addIssue({ code: 'custom', path: ['PAYOUT_PROVIDER'], message: 'Production needs a real payout partner' });
  }
  if (env.ONRAMP_PROVIDER === 'moonpay' && (!env.MOONPAY_PUBLISHABLE_KEY || !env.MOONPAY_SECRET_KEY)) {
    ctx.addIssue({
      code: 'custom',
      path: ['MOONPAY_SECRET_KEY'],
      message: 'ONRAMP_PROVIDER=moonpay needs MOONPAY_PUBLISHABLE_KEY and MOONPAY_SECRET_KEY',
    });
  }
  if (env.NODE_ENV === 'production' && env.ONRAMP_PROVIDER === 'simulated') {
    ctx.addIssue({ code: 'custom', path: ['ONRAMP_PROVIDER'], message: 'Production needs a real onramp partner' });
  }
  if (env.ONRAMP_MIN_THB > env.ONRAMP_MAX_THB) {
    ctx.addIssue({ code: 'custom', path: ['ONRAMP_MIN_THB'], message: 'ONRAMP_MIN_THB is above ONRAMP_MAX_THB' });
  }
  if (env.SETTLEMENT_RAIL === 'near') {
    for (const name of NEAR_RAIL_REQUIRED) {
      if (!env[name]) {
        ctx.addIssue({ code: 'custom', path: [name], message: `SETTLEMENT_RAIL=near needs ${NEAR_RAIL_REQUIRED.join(', ')}` });
      }
    }
  }
  if (env.NEAR_TESTNET_FAUCET && env.NEAR_NETWORK !== 'testnet') {
    ctx.addIssue({ code: 'custom', path: ['NEAR_TESTNET_FAUCET'], message: 'NEAR_TESTNET_FAUCET works on NEAR_NETWORK=testnet only' });
  }
  if (env.NODE_ENV === 'production') checkProduction(env, ctx);
}

/** A secret someone could guess: few distinct characters ("x" × 32), or written by a person ("change me"). */
function looksGuessable(secret: string): boolean {
  return new Set(secret).size < 10 || /change.?me|example|placeholder|password|secret/i.test(secret);
}

/** Local, test and sandbox settings that must never reach production. */
function checkProduction(env: Env, ctx: z.RefinementCtx): void {
  const refuse = (path: keyof Env, message: string) => ctx.addIssue({ code: 'custom', path: [path], message });

  if (env.CHAIN_ID === ANVIL_CHAIN_ID) refuse('CHAIN_ID', 'CHAIN_ID 31337 is a local anvil chain and is refused in production');
  if (env.ONRAMP_CHAIN_ID === ANVIL_CHAIN_ID) {
    refuse('ONRAMP_CHAIN_ID', 'ONRAMP_CHAIN_ID 31337 is a local anvil chain and is refused in production');
  }
  for (const name of ['QUOTE_SIGNER_PRIVATE_KEY', 'RELAYER_PRIVATE_KEY'] as const) {
    const key = env[name];
    if (key && isPublicTestKey(key)) refuse(name, `${name} is one of anvil's public test keys and is refused in production`);
  }
  if (env.SETTLEMENT_RAIL === 'near' && env.NEAR_NETWORK === 'testnet') {
    refuse('NEAR_NETWORK', 'NEAR_NETWORK=testnet is refused in production');
  }
  if (env.NEAR_TESTNET_FAUCET) refuse('NEAR_TESTNET_FAUCET', 'NEAR_TESTNET_FAUCET gives away test tokens and is refused in production');

  const generate = `generate one with: node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`;
  if (looksGuessable(env.JWT_SECRET)) refuse('JWT_SECRET', `JWT_SECRET looks guessable; ${generate}`);
  if (env.OPS_API_TOKEN && looksGuessable(env.OPS_API_TOKEN)) refuse('OPS_API_TOKEN', `OPS_API_TOKEN looks guessable; ${generate}`);
  if (env.OPS_API_TOKEN && env.OPS_API_TOKEN === env.JWT_SECRET) refuse('OPS_API_TOKEN', 'OPS_API_TOKEN must differ from JWT_SECRET');

  if (env.RATE_SOURCE === 'fixed') refuse('RATE_SOURCE', 'RATE_SOURCE=fixed is for offline development; production prices at live rates');
  if (!env.RATE_LIMIT_ENABLED) refuse('RATE_LIMIT_ENABLED', 'Rate limits cannot be turned off in production');

  if (env.XENDIT_SECRET_KEY && /^xnd_(public_)?development_/.test(env.XENDIT_SECRET_KEY)) {
    refuse('XENDIT_SECRET_KEY', 'XENDIT_SECRET_KEY is a Xendit test-mode key and is refused in production');
  }
  for (const name of ['MOONPAY_PUBLISHABLE_KEY', 'MOONPAY_SECRET_KEY', 'MOONPAY_WEBHOOK_KEY'] as const) {
    const key = env[name];
    if (key && /^[a-z]{2}_test_/.test(key)) refuse(name, `${name} is a MoonPay sandbox key and is refused in production`);
  }
  if (new URL(env.MOONPAY_WIDGET_URL).hostname.includes('sandbox')) {
    refuse('MOONPAY_WIDGET_URL', "MOONPAY_WIDGET_URL is MoonPay's sandbox; production uses https://buy.moonpay.com");
  }

  // Webhooks fail closed without their secret: in production that silently loses every partner update.
  if (env.PAYOUT_PROVIDER === 'xendit' && !env.XENDIT_CALLBACK_TOKEN) {
    refuse('XENDIT_CALLBACK_TOKEN', 'Production needs XENDIT_CALLBACK_TOKEN, or every payout webhook is refused');
  }
  if (env.ONRAMP_PROVIDER === 'moonpay' && !env.MOONPAY_WEBHOOK_KEY) {
    refuse('MOONPAY_WEBHOOK_KEY', 'Production needs MOONPAY_WEBHOOK_KEY, or every onramp webhook is refused');
  }
  // Paying personal QRs turns the product into a cash-out tool for any account (docs/scope.md).
  if (!env.MERCHANT_QR_ONLY) refuse('MERCHANT_QR_ONLY', 'Production pays merchant QRs only: set MERCHANT_QR_ONLY=true');
  if (/\.local(:\d+)?$/i.test(env.SIWE_DOMAIN)) {
    refuse('SIWE_DOMAIN', "SIWE_DOMAIN is a local name; production signs in on the API's real domain");
  }
}

/** Validates configuration at startup. Empty strings count as unset. */
export function loadEnv(source: Record<string, string | undefined> = process.env): Env {
  const cleaned = Object.fromEntries(
    Object.entries(source).filter(([, value]) => value !== undefined && value !== ''),
  );
  const result = envSchema.superRefine(checkCombinations).safeParse(cleaned);
  if (!result.success) {
    throw new Error(`Invalid environment configuration:\n${z.prettifyError(result.error)}`);
  }
  return result.data;
}
