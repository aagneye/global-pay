import { z } from 'zod';
import { FIAT_DECIMALS, RATE_DECIMALS, parseDecimal } from '../domain/money.js';
import { addressSchema, privateKeySchema } from '../shared/schemas.js';

const testDestinationsSchema = z.record(
  z.string(),
  z.object({ channelCode: z.string(), accountNumber: z.string(), accountHolderName: z.string() }),
);

export const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  HOST: z.string().default('0.0.0.0'),
  PORT: z.coerce.number().int().positive().default(3000),

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

  QUOTE_TTL_SECONDS: z.coerce.number().int().min(15).max(300).default(60),
  SPREAD_BPS: z.coerce.number().int().min(0).max(1_000).default(100),
  MERCHANT_QR_ONLY: z.stringbool().default(false),

  /** `public`: Coinbase's public USDC rates. `fixed`: FIXED_USDC_THB_RATE (offline development and tests). */
  RATE_SOURCE: z.enum(['public', 'fixed']).default('public'),
  /** THB per 1 USDC, as a decimal. Becomes rateE8. */
  FIXED_USDC_THB_RATE: z
    .string()
    .default('35.00')
    .transform((value, ctx) => {
      const rateE8 = parseDecimal(value, RATE_DECIMALS);
      if (rateE8 === null || rateE8 <= 0n) {
        ctx.addIssue({ code: 'custom', message: 'FIXED_USDC_THB_RATE must be a positive decimal, e.g. 35.00' });
        return z.NEVER;
      }
      return rateE8;
    }),

  /** `simulated`: no money moves (local and tests). `xendit`: Xendit payouts (sandbox first). */
  PAYOUT_PROVIDER: z.enum(['simulated', 'xendit']).default('simulated'),
  PAYOUT_POLL_MS: z.coerce.number().int().min(200).default(2_000),
  /** How often to ask the partner about a pending payout. */
  PAYOUT_RECHECK_MS: z.coerce.number().int().min(0).default(5_000),
  /** A payout still pending after this long becomes UNKNOWN. */
  PAYOUT_PENDING_DEADLINE_MS: z.coerce.number().int().min(60_000).default(30 * 60_000),
  /** Refuse quotes when the partner's float minus the amount would go below this (THB). */
  PAYOUT_FLOAT_BUFFER_THB: z
    .string()
    .default('0')
    .transform((value, ctx) => {
      const minor = parseDecimal(value, FIAT_DECIMALS.THB);
      if (minor === null) {
        ctx.addIssue({ code: 'custom', message: 'PAYOUT_FLOAT_BUFFER_THB must be a THB amount, e.g. 5000 or 5000.00' });
        return z.NEVER;
      }
      return minor;
    }),

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
  /** Alert when the relayer has less than this much ETH. */
  OPS_MIN_RELAYER_ETH: z.string().regex(/^\d+(\.\d+)?$/).default('0.005'),
  /** Alert when the payout float is below this (THB). */
  OPS_MIN_PAYOUT_FLOAT_THB: z
    .string()
    .default('0')
    .transform((value, ctx) => {
      const minor = parseDecimal(value, FIAT_DECIMALS.THB);
      if (minor === null) {
        ctx.addIssue({ code: 'custom', message: 'OPS_MIN_PAYOUT_FLOAT_THB must be a THB amount, e.g. 5000 or 5000.00' });
        return z.NEVER;
      }
      return minor;
    }),

  INDEXER_POLL_MS: z.coerce.number().int().min(200).default(4_000),
  INDEXER_CONFIRMATIONS: z.coerce.number().int().min(0).default(2),
  /** First block to index: the settlement contract's deployment block. */
  INDEXER_START_BLOCK: z.coerce.bigint().nonnegative().default(0n),
});

export type Env = z.infer<typeof envSchema>;

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
