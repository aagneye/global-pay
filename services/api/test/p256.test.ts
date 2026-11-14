import { keccak256, toHex } from 'viem';
import { describe, expect, it } from 'vitest';
import { isP256PublicKey, verifyTapSignature } from '../src/lib/p256.js';
import { phoneKey } from './support/phone-key.js';

const challenge = keccak256(toHex('challenge-1'));

describe('tap signatures (P-256)', () => {
  it("accepts the phone's signature over the prefixed challenge", () => {
    const phone = phoneKey();
    expect(isP256PublicKey(phone.publicKey)).toBe(true);
    expect(verifyTapSignature(phone.publicKey, challenge, phone.signTap(challenge))).toBe(true);
  });

  it('rejects another challenge, another key, a bare challenge signature, and junk', () => {
    const phone = phoneKey();
    const signature = phone.signTap(challenge);
    expect(verifyTapSignature(phone.publicKey, keccak256(toHex('challenge-2')), signature)).toBe(false);
    expect(verifyTapSignature(phoneKey().publicKey, challenge, signature)).toBe(false);
    expect(verifyTapSignature(phone.publicKey, challenge, '0xdeadbeef')).toBe(false);
    expect(verifyTapSignature('not a key', challenge, signature)).toBe(false);
  });

  it('accepts only P-256 public keys', () => {
    expect(isP256PublicKey(phoneKey('secp256k1').publicKey)).toBe(false);
    expect(isP256PublicKey(Buffer.from('nope').toString('base64'))).toBe(false);
  });
});
