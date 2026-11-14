import { createPublicKey, verify } from 'node:crypto';
import { type Hex, hexToBytes } from 'viem';
import { TAP_SIGNING_PREFIX } from '../domain/p2p.js';

/**
 * Checks that `spkiBase64` is a P-256 (secp256r1) public key in SPKI DER, the form Android's Keystore
 * exports. Returns false for anything else, including other curves.
 */
export function isP256PublicKey(spkiBase64: string): boolean {
  try {
    const key = createPublicKey({ key: Buffer.from(spkiBase64, 'base64'), format: 'der', type: 'spki' });
    return key.asymmetricKeyType === 'ec' && key.asymmetricKeyDetails?.namedCurve === 'prime256v1';
  } catch {
    return false;
  }
}

/** The bytes a phone signs when tapped: a fixed prefix, then the request's 32-byte challenge. */
export function tapMessage(challenge: Hex): Buffer {
  return Buffer.concat([Buffer.from(TAP_SIGNING_PREFIX, 'ascii'), Buffer.from(hexToBytes(challenge))]);
}

/**
 * Verifies a tap: an ECDSA P-256 / SHA-256 signature (DER, as Android's `SHA256withECDSA` produces) by
 * the device's key over `tapMessage(challenge)`.
 */
export function verifyTapSignature(spkiBase64: string, challenge: Hex, signature: Hex): boolean {
  try {
    const key = createPublicKey({ key: Buffer.from(spkiBase64, 'base64'), format: 'der', type: 'spki' });
    return verify('sha256', tapMessage(challenge), { key, dsaEncoding: 'der' }, Buffer.from(hexToBytes(signature)));
  } catch {
    return false;
  }
}
