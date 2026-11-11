import { z } from 'zod';
import { addressSchema, privateKeySchema } from '../shared/schemas.js';

export const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  HOST: z.string().default('0.0.0.0'),
  PORT: z.coerce.number().int().positive().default(3000),

  DATABASE_URL: z.string().min(1),
  JWT_SECRET: z.string().min(32, 'JWT_SECRET must be at least 32 characters'),

  CHAIN_ID: z.coerce.number().int().positive().default(84532),
  RPC_URL: z.url(),
  EXPLORER_URL: z.url().default('https://sepolia.basescan.org'),
  USDC_ADDRESS: addressSchema,
  SETTLEMENT_ADDRESS: addressSchema.optional(),

  QUOTE_SIGNER_PRIVATE_KEY: privateKeySchema.optional(),
  RELAYER_PRIVATE_KEY: privateKeySchema.optional(),

  QUOTE_TTL_SECONDS: z.coerce.number().int().min(15).max(300).default(60),
  SPREAD_BPS: z.coerce.number().int().min(0).max(1_000).default(100),
  MERCHANT_QR_ONLY: z.stringbool().default(false),

  PAYOUT_DELAY_MS: z.coerce.number().int().min(0).default(3_000),
  PAYOUT_FAILURE_RATE: z.coerce.number().min(0).max(1).default(0),

  INDEXER_POLL_MS: z.coerce.number().int().min(500).default(4_000),
  INDEXER_CONFIRMATIONS: z.coerce.number().int().min(0).default(2),
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
