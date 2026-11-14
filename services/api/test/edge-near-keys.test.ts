import { createHash } from 'node:crypto';
import { KeyPairSigner, baseEncode } from 'near-api-js';
import { describe, expect, it } from 'vitest';
import {
  decodeBase64,
  encodeBase64,
  implicitAccountOf,
  keyPairFromSeed,
  publicKeyOfImplicitAccount,
  verifyEd25519,
} from '../src/adapters/near/keys.js';
import { NEP413_TAG, nep413Hash, verifyNep413 } from '../src/adapters/near/nep413.js';
import { NEAR, implicitAccount, nearTestKey } from './support/near.js';

const PAYER = implicitAccount(NEAR.payerKey);
const PAYER_PUBLIC_KEY = NEAR.payerKey.getPublicKey().toString();
const NONCE = Buffer.alloc(32, 7);

/** RFC 8032 section 7.1, test 1 (public test vector, no funds anywhere). */
const RFC8032_SEED = '9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60';
const RFC8032_PUBLIC = 'd75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a';

describe('implicit account <-> public key', () => {
  it('round-trips an implicit account through its public key', () => {
    expect(implicitAccountOf(publicKeyOfImplicitAccount(PAYER))).toBe(PAYER);
    expect(publicKeyOfImplicitAccount(implicitAccountOf(PAYER_PUBLIC_KEY)!)).toBe(PAYER_PUBLIC_KEY);
  });

  it.each([
    ['no prefix', () => PAYER_PUBLIC_KEY.slice('ed25519:'.length)],
    ['an upper-case prefix', () => PAYER_PUBLIC_KEY.replace('ed25519:', 'ED25519:')],
    ['a secp256k1 prefix', () => PAYER_PUBLIC_KEY.replace('ed25519:', 'secp256k1:')],
    ['a character outside base58 (0)', () => `ed25519:0${PAYER_PUBLIC_KEY.slice(9)}`],
    ['a 31-byte key', () => `ed25519:${baseEncode(Buffer.alloc(31, 0x11))}`],
    ['a 33-byte key', () => `ed25519:${baseEncode(Buffer.alloc(33, 0x11))}`],
    ['an empty key', () => 'ed25519:'],
    ['the account hex itself', () => PAYER],
  ])('has no implicit account for %s', (_name, key) => {
    expect(implicitAccountOf(key())).toBeNull();
  });

  it.each([
    ['upper-case hex', PAYER.toUpperCase()],
    ['63 characters', PAYER.slice(1)],
    ['65 characters', `${PAYER}0`],
    ['a named account', 'alice.testnet'],
    ['a 0x prefix', `0x${PAYER.slice(2)}`],
  ])('refuses to derive a key from %s', (_name, account) => {
    expect(() => publicKeyOfImplicitAccount(account)).toThrow(/is not a NEAR implicit account/);
  });
});

describe('keyPairFromSeed', () => {
  it('matches the RFC 8032 test vector', () => {
    const key = keyPairFromSeed(Buffer.from(RFC8032_SEED, 'hex'));
    expect(Buffer.from(key.getPublicKey().data).toString('hex')).toBe(RFC8032_PUBLIC);
    expect(implicitAccount(key)).toBe(RFC8032_PUBLIC);
  });

  it('is deterministic, and different seeds give different accounts', () => {
    const seed = createHash('sha256').update('edge').digest();
    expect(keyPairFromSeed(seed).toString()).toBe(keyPairFromSeed(Uint8Array.from(seed)).toString());
    expect(implicitAccount(nearTestKey('a'))).not.toBe(implicitAccount(nearTestKey('b')));
  });

  it.each([0, 31, 33, 64])('refuses a %i-byte seed', (length) => {
    expect(() => keyPairFromSeed(new Uint8Array(length))).toThrow(/32 bytes/);
  });
});

describe('verifyEd25519', () => {
  const message = Buffer.from('hello');
  const signature = () => NEAR.payerKey.sign(message).signature;

  it("accepts the key's own signature, and nothing else", () => {
    expect(verifyEd25519(PAYER_PUBLIC_KEY, message, signature())).toBe(true);
    expect(verifyEd25519(NEAR.relayerKey.getPublicKey().toString(), message, signature())).toBe(false);
    expect(verifyEd25519(PAYER_PUBLIC_KEY, Buffer.from('hellO'), signature())).toBe(false);
  });

  it('is false, never a throw, for a signature of the wrong length', () => {
    const sig = signature();
    expect(verifyEd25519(PAYER_PUBLIC_KEY, message, sig.subarray(0, 63))).toBe(false);
    expect(verifyEd25519(PAYER_PUBLIC_KEY, message, Buffer.concat([sig, Buffer.of(0)]))).toBe(false);
    expect(verifyEd25519(PAYER_PUBLIC_KEY, message, new Uint8Array(0))).toBe(false);
  });

  it('is false, never a throw, for a malformed or non-ed25519 key', () => {
    const sig = signature();
    for (const key of ['', 'ed25519:', 'ed25519:0OIl', `secp256k1:${baseEncode(Buffer.alloc(64, 1))}`, 'nonsense']) {
      expect(verifyEd25519(key, message, sig)).toBe(false);
    }
  });

  it('is false for a flipped bit anywhere in the signature', () => {
    const sig = signature();
    for (const index of [0, 31, 32, 63]) {
      const flipped = Uint8Array.from(sig);
      flipped[index] = flipped[index]! ^ 1;
      expect(verifyEd25519(PAYER_PUBLIC_KEY, message, flipped)).toBe(false);
    }
  });
});

describe('decodeBase64', () => {
  const bytes = Uint8Array.from({ length: 64 }, (_, i) => i * 3);
  const canonical = encodeBase64(bytes);

  it('round-trips canonical base64', () => {
    expect(decodeBase64(canonical)).toEqual(bytes);
    expect(decodeBase64('')).toEqual(new Uint8Array(0));
  });

  it('refuses non-canonical padding bits that Buffer would quietly accept', () => {
    // The last data character of a 64-byte value carries 4 unused bits; canonical base64 leaves them 0.
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
    const last = canonical.length - 3;
    const loose = canonical.slice(0, last) + alphabet[alphabet.indexOf(canonical[last]!) | 1] + '==';
    expect(new Uint8Array(Buffer.from(loose, 'base64'))).toEqual(bytes);
    expect(decodeBase64(loose)).toBeNull();
  });

  it.each([
    ['URL-safe characters', (s: string) => s.replace(/\+/g, '-').replace(/\//g, '_') + '-'],
    ['missing padding', (s: string) => s.replace(/=+$/, '')],
    ['a trailing newline', (s: string) => `${s}\n`],
    ['inner whitespace', (s: string) => `${s.slice(0, 10)} ${s.slice(10)}`],
    ['too much padding', (s: string) => `${s}==`],
    ['a 0x hex prefix', () => `0x${Buffer.from(bytes).toString('hex')}`],
    ['padding in the middle', (s: string) => `${s.slice(0, 4)}==${s.slice(6)}`],
  ])('refuses %s', (_name, change) => {
    expect(decodeBase64(change(canonical))).toBeNull();
  });
});

describe('NEP-413 hash', () => {
  const payload = { message: 'Sign in', nonce: NONCE, recipient: 'globalpay.local' };

  it('refuses a nonce that is not 32 bytes', () => {
    expect(() => nep413Hash({ ...payload, nonce: new Uint8Array(31) })).toThrow(/32 bytes/);
    expect(() => nep413Hash({ ...payload, nonce: new Uint8Array(33) })).toThrow(/32 bytes/);
  });

  it('prefixes the 2^31 + 413 tag, and changes with every field', () => {
    expect(NEP413_TAG).toBe(2_147_484_061);
    const base = Buffer.from(nep413Hash(payload)).toString('hex');
    const variants = [
      { ...payload, message: 'Sign in!' },
      { ...payload, recipient: 'globalpay.locaL' },
      { ...payload, nonce: Buffer.alloc(32, 8) },
      { ...payload, callbackUrl: '' },
      { ...payload, callbackUrl: 'https://globalpay.local' },
    ];
    const hashes = variants.map((variant) => Buffer.from(nep413Hash(variant)).toString('hex'));
    expect(new Set([base, ...hashes]).size).toBe(variants.length + 1);
  });

  it('frames strings by UTF-8 byte length, not character count', () => {
    // "฿" is 1 UTF-16 unit but 3 UTF-8 bytes: framed by characters, "฿" and "abc" would collide in length.
    const baht = nep413Hash({ ...payload, message: '฿' });
    const manual = createHash('sha256')
      .update(
        Buffer.concat([
          u32(NEP413_TAG),
          u32(3),
          Buffer.from('฿', 'utf8'),
          NONCE,
          u32(15),
          Buffer.from('globalpay.local'),
          Buffer.of(0),
        ]),
      )
      .digest();
    expect(Buffer.from(baht)).toEqual(manual);
  });

  it("verifies near-api-js's own NEP-413 signatures, with and without a callback URL", async () => {
    const signer = new KeyPairSigner(NEAR.payerKey);
    const plain = await signer.signNep413Message(PAYER, payload);
    expect(verifyNep413(payload, PAYER_PUBLIC_KEY, plain.signature)).toBe(true);

    const withCallback = await signer.signNep413Message(PAYER, { ...payload, callbackUrl: 'https://evil.example' });
    expect(verifyNep413({ ...payload, callbackUrl: 'https://evil.example' }, PAYER_PUBLIC_KEY, withCallback.signature)).toBe(true);
    // The server never sends a callback URL, so such a signature doesn't verify for it.
    expect(verifyNep413(payload, PAYER_PUBLIC_KEY, withCallback.signature)).toBe(false);
  });

  it("refuses a signature over the bare message instead of the NEP-413 hash", () => {
    const raw = NEAR.payerKey.sign(Buffer.from(payload.message)).signature;
    expect(verifyNep413(payload, PAYER_PUBLIC_KEY, raw)).toBe(false);
    const overHash = NEAR.payerKey.sign(nep413Hash(payload)).signature;
    expect(verifyNep413(payload, PAYER_PUBLIC_KEY, overHash)).toBe(true);
  });
});

function u32(value: number): Buffer {
  const bytes = Buffer.alloc(4);
  bytes.writeUInt32LE(value);
  return bytes;
}
