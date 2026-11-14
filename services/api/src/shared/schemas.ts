import type { Address, Hex } from 'viem';
import { z } from 'zod';
import { AppError } from './errors.js';

/*
 * Request schemas validate and convert (e.g. integer strings → bigint).
 * Response schemas describe plain JSON and never transform, so the OpenAPI spec can show them.
 */

const ADDRESS = /^0x[a-fA-F0-9]{40}$/;
const HEX = /^0x(?:[a-fA-F0-9]{2})*$/;
const BYTES32 = /^0x[a-fA-F0-9]{64}$/;
const UINT = /^\d+$/;
/** A NEAR implicit account: the 32-byte ed25519 public key as lowercase hex. */
const NEAR_IMPLICIT_ACCOUNT = /^[0-9a-f]{64}$/;
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;
const NEAR_PUBLIC_KEY = /^ed25519:[1-9A-HJ-NP-Za-km-z]{32,44}$/;

/** 0x-prefixed 20-byte EVM address. */
export const addressSchema = z
  .string()
  .regex(ADDRESS, 'expected a 0x-prefixed 20-byte address')
  .transform((value) => value as Address);

/**
 * A wallet: a 0x-prefixed EVM address (EVM rail) or a NEAR implicit account, 64 lowercase hex (NEAR rail).
 * A plain string here: the services check it against the active settlement rail (`parseWallet`).
 * Typed `Address` for the shared code; on the NEAR rail it holds the account ID.
 */
export const walletSchema = z
  .string()
  .min(1)
  .max(128)
  .transform((value) => value as Address);

export type SettlementRail = 'evm' | 'near';

/**
 * The wallet in the active rail's format: a checksum-insensitive 0x address (EVM) or a NEAR implicit
 * account (NEAR). Anything else is a 400, like a schema error.
 */
export function parseWallet(rail: SettlementRail, value: string): Address {
  if (rail === 'near') {
    if (!NEAR_IMPLICIT_ACCOUNT.test(value)) {
      throw new AppError('invalid_request', 'expected a NEAR implicit account (64 lowercase hex)', 400);
    }
    return value as Address;
  }
  if (!ADDRESS.test(value)) throw new AppError('invalid_request', 'expected a 0x-prefixed 20-byte address', 400);
  return value as Address;
}

/** Standard base64, e.g. a borsh-encoded NEAR SignedDelegate or an ed25519 signature. */
export const base64Schema = z.string().regex(BASE64, 'expected base64');

/** A NEAR ed25519 public key, "ed25519:" + base58. */
export const nearPublicKeySchema = z.string().regex(NEAR_PUBLIC_KEY, 'expected "ed25519:" followed by a base58 public key');

export function isEvmAddress(value: string): value is Address {
  return ADDRESS.test(value);
}

export function isNearImplicitAccount(value: string): boolean {
  return NEAR_IMPLICIT_ACCOUNT.test(value);
}

export function isHex(value: string): value is Hex {
  return HEX.test(value);
}

/** 0x-prefixed hex string with whole bytes (signatures, calldata). */
export const hexSchema = z
  .string()
  .regex(HEX, 'expected 0x-prefixed hex')
  .transform((value) => value as Hex);

/** 0x-prefixed 32-byte value (quote IDs, hashes). */
export const bytes32Schema = z
  .string()
  .regex(BYTES32, 'expected a 0x-prefixed 32-byte hex value')
  .transform((value) => value as Hex);

/** 0x-prefixed 32-byte private key. */
export const privateKeySchema = bytes32Schema;

/**
 * Money crosses the API as integer strings in minor units (e.g. "10000" = 100.00 THB),
 * because JSON numbers can't hold bigint safely.
 */
export const minorUnitsSchema = z
  .string()
  .regex(UINT, 'expected a non-negative integer string in minor units')
  .transform((value) => BigInt(value));

/** Response shapes. */
export const out = {
  address: z.string().regex(ADDRESS).meta({ example: '0x15d34AAf54267DB7D7c367839AAf71A00a2C6A65' }),
  hex: z.string().regex(HEX),
  bytes32: z.string().regex(BYTES32),
  /** A non-negative integer (amount, rate) as a string. */
  uint: z.string().regex(UINT),
  dateTime: z.iso.datetime(),
} as const;

export const errorResponseSchema = z
  .object({
    error: z.string().meta({ description: 'Stable machine-readable code', example: 'kyc_required' }),
    message: z.string().optional(),
    issues: z.array(z.unknown()).optional(),
  })
  .meta({ id: 'Error' });

/**
 * Error responses, for the OpenAPI spec. They all share the named `Error` schema, so clients get one
 * error type: 400 invalid request, 401 not signed in, 403 not allowed, 404 not found, 409 conflicts with the current state,
 * 422 rejected (see `error`), 429 too many at once, 503 a dependency (rate feed, chain, config) is unavailable.
 */
export const errorResponses = {
  400: errorResponseSchema,
  401: errorResponseSchema,
  403: errorResponseSchema,
  404: errorResponseSchema,
  409: errorResponseSchema,
  422: errorResponseSchema,
  429: errorResponseSchema,
  503: errorResponseSchema,
} as const;

export const bearerAuth = [{ bearerAuth: [] }];
