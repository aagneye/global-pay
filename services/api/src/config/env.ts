import { z } from 'zod';
import { RATE_DECIMALS, parseDecimal } from '../domain/money.js';
import { addressSchema, privateKeySchema } from '../shared/schemas.js';

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

  PAYOUT_POLL_MS: z.coerce.number().int().min(200).default(2_000),
  /** How often to ask the partner about a pending payout. */
  PAYOUT_RECHECK_MS: z.coerce.number().int().min(0).default(5_000),
  /** A payout still pending after this long becomes UNKNOWN. */
  PAYOUT_PENDING_DEADLINE_MS: z.coerce.number().int().min(60_000).default(30 * 60_000),

  // Simulated partner
  PAYOUT_DELAY_MS: z.coerce.number().int().min(0).default(3_000),
  /** 0..1. Set to 1 to force failures and exercise refunds. */
  PAYOUT_FAILURE_RATE: z.coerce.number().min(0).max(1).default(0),
  /** 0..1. Set to 1 to make every outcome unclear and exercise the operator flow. */
  PAYOUT_UNKNOWN_RATE: z.coerce.number().min(0).max(1).default(0),

  INDEXER_POLL_MS: z.coerce.number().int().min(200).default(4_000),
  INDEXER_CONFIRMATIONS: z.coerce.number().int().min(0).default(2),
  /** First block to index: the settlement contract's deployment block. */
  INDEXER_START_BLOCK: z.coerce.bigint().nonnegative().default(0n),
});

export type Env = z.infer<typeof envSchema>;

/** Validates configuration at startup. Empty strings count as unset. */
export function loadEnv(source: Record<string, string | undefined> = process.env): Env {
  const cleaned = Object.fromEntries(
    Object.entries(source).filter(([, value]) => value !== undefined && value !== ''),
  );
  const result = envSchema.safeParse(cleaned);
  if (!result.success) {
    throw new Error(`Invalid environment configuration:\n${z.prettifyError(result.error)}`);
  }
  return result.data;
}
