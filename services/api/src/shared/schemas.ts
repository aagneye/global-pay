import type { Address, Hex } from 'viem';
import { z } from 'zod';

/*
 * Request schemas validate and convert (e.g. integer strings → bigint).
 * Response schemas describe plain JSON and never transform, so the OpenAPI spec can show them.
 */

const ADDRESS = /^0x[a-fA-F0-9]{40}$/;
const HEX = /^0x(?:[a-fA-F0-9]{2})*$/;
const BYTES32 = /^0x[a-fA-F0-9]{64}$/;
const UINT = /^\d+$/;

/** 0x-prefixed 20-byte EVM address. */
export const addressSchema = z
  .string()
  .regex(ADDRESS, 'expected a 0x-prefixed 20-byte address')
  .transform((value) => value as Address);

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
 * error type: 400 invalid request, 401 not signed in, 403 not allowed, 404 not found,
 * 422 rejected (see `error`), 503 a dependency (rate feed, chain, config) is unavailable.
 */
export const errorResponses = {
  400: errorResponseSchema,
  401: errorResponseSchema,
  403: errorResponseSchema,
  404: errorResponseSchema,
  422: errorResponseSchema,
  503: errorResponseSchema,
} as const;

export const bearerAuth = [{ bearerAuth: [] }];
