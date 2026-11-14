import { PublicKey, baseDecode, baseEncode } from 'near-api-js';

/**
 * NEAR key and account formats shared with the app and the contracts:
 * - an implicit account ID is the lowercase hex of the 32-byte ed25519 public key;
 * - a public key string is "ed25519:" + base58(public key).
 */

const ED25519_PREFIX = 'ed25519:';

/** The implicit account of an "ed25519:<base58>" public key; null if it isn't a valid ed25519 key. */
export function implicitAccountOf(publicKey: string): string | null {
  if (!publicKey.startsWith(ED25519_PREFIX)) return null;
  try {
    const bytes = baseDecode(publicKey.slice(ED25519_PREFIX.length));
    return bytes.length === 32 ? Buffer.from(bytes).toString('hex') : null;
  } catch {
    return null;
  }
}

/** The "ed25519:<base58>" public key an implicit account (64 lowercase hex) stands for. */
export function publicKeyOfImplicitAccount(accountId: string): string {
  if (!/^[0-9a-f]{64}$/.test(accountId)) throw new Error(`${accountId} is not a NEAR implicit account`);
  return `${ED25519_PREFIX}${baseEncode(Buffer.from(accountId, 'hex'))}`;
}

/** Verifies an ed25519 signature over `message`. False for a malformed key or signature. */
export function verifyEd25519(publicKey: string, message: Uint8Array, signature: Uint8Array): boolean {
  if (signature.length !== 64) return false;
  try {
    const key = PublicKey.fromString(publicKey);
    return key.keyType === 0 && key.verify(message, signature);
  } catch {
    return false;
  }
}

/** Decodes standard base64; null if it isn't canonical base64. */
export function decodeBase64(value: string): Uint8Array | null {
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(value) || value.length % 4 !== 0) return null;
  const bytes = Buffer.from(value, 'base64');
  return bytes.toString('base64') === value ? new Uint8Array(bytes) : null;
}

export function encodeBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64');
}
