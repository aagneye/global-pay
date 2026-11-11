import type { Address, Hex } from 'viem';
import { z } from 'zod';

/** 0x-prefixed 20-byte EVM address. */
export const addressSchema = z
  .string()
  .regex(/^0x[a-fA-F0-9]{40}$/, 'expected a 0x-prefixed 20-byte address')
  .transform((value) => value as Address);

/** 0x-prefixed hex string with whole bytes (signatures, calldata). */
export const hexSchema = z
  .string()
  .regex(/^0x(?:[a-fA-F0-9]{2})*$/, 'expected 0x-prefixed hex')
  .transform((value) => value as Hex);

/** 0x-prefixed 32-byte value (quote IDs, hashes). */
export const bytes32Schema = z
  .string()
  .regex(/^0x[a-fA-F0-9]{64}$/, 'expected a 0x-prefixed 32-byte hex value')
  .transform((value) => value as Hex);

/** 0x-prefixed 32-byte private key. */
export const privateKeySchema = bytes32Schema;

/**
 * Money crosses the API as integer strings in minor units (e.g. "10000" = 100.00 THB),
 * because JSON numbers can't hold bigint safely.
 */
export const minorUnitsSchema = z
  .string()
  .regex(/^\d+$/, 'expected a non-negative integer string in minor units')
  .transform((value) => BigInt(value));
