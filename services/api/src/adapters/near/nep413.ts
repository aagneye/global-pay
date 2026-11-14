import { createHash } from 'node:crypto';
import { verifyEd25519 } from './keys.js';

/**
 * NEP-413 (sign a message off-chain with a NEAR key), as the app signs sign-in messages:
 *
 *   signed bytes = sha256( borsh(u32 2^31 + 413) ‖ borsh(Payload{ message: String, nonce: [u8; 32],
 *                                                                recipient: String, callback_url: Option<String> }) )
 */
export const NEP413_TAG = 2 ** 31 + 413;

export interface Nep413Payload {
  message: string;
  /** Exactly 32 bytes. */
  nonce: Uint8Array;
  recipient: string;
  callbackUrl?: string;
}

/** The 32-byte hash an NEP-413 signature signs. */
export function nep413Hash(payload: Nep413Payload): Uint8Array {
  if (payload.nonce.length !== 32) throw new Error('NEP-413 nonce must be 32 bytes');
  const parts: Uint8Array[] = [u32(NEP413_TAG), string(payload.message), payload.nonce, string(payload.recipient)];
  parts.push(payload.callbackUrl === undefined ? Uint8Array.of(0) : concat([Uint8Array.of(1), string(payload.callbackUrl)]));
  return new Uint8Array(createHash('sha256').update(concat(parts)).digest());
}

/** True if `signature` (64 bytes) is `publicKey`'s ed25519 signature over the payload's NEP-413 hash. */
export function verifyNep413(payload: Nep413Payload, publicKey: string, signature: Uint8Array): boolean {
  return verifyEd25519(publicKey, nep413Hash(payload), signature);
}

function u32(value: number): Uint8Array {
  const bytes = new Uint8Array(4);
  new DataView(bytes.buffer).setUint32(0, value, true);
  return bytes;
}

function string(value: string): Uint8Array {
  const utf8 = new TextEncoder().encode(value);
  return concat([u32(utf8.length), utf8]);
}

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}
