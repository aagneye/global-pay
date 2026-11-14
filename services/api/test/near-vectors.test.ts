import { createHash, createPublicKey, verify } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { baseDecode } from 'near-api-js';
import { describe, expect, it } from 'vitest';
import { checkSignedDelegate } from '../src/adapters/near/delegate.js';
import { implicitAccountOf } from '../src/adapters/near/keys.js';
import { verifyNep413 } from '../src/adapters/near/nep413.js';
import { VECTORS_PATH, renderNearVectors } from '../scripts/near-vectors.js';

const vectors = JSON.parse(readFileSync(VECTORS_PATH, 'utf8'));

/** Copied from contracts-near/settlement/tests/fixtures/quote.json (TEST ONLY: RFC 8032 keys). */
const CONTRACT_QUOTE_JSON =
  '{"quote_id":"0xd213c5383d59bc060266adae2f78f8a54a4c50583c442beb888893df13746e9f",' +
  '"payer":"3d4017c3e843895a92b70aa74d1b7ebc9c982ccf2ec4968cc0cd55f12af4660c","token":"test-usdc.testnet",' +
  '"token_amount":"2850000","fiat_currency":"THB","fiat_amount":"10000",' +
  '"merchant_ref_hash":"0x33b9c6437277fd4075ab90fd462a5d08797ea1f845c6bcaac42479041bf746be","expires_at_ms":1800000060000}';
const CONTRACT_SIGNATURE = 'y5d7XAmigk1YwvgmGP2QPHlcRQe6O41wO5LmfRhZIIMhJ97ZAwDm4PPCdzEIKI3WB7EtNCtPouOVmLw4sDPkAQ==';
const CONTRACT_FIXTURE = {
  quote_signer_public_key: 'ed25519:FVen3X669xLzsi6N2V91DoiyzHzg1uAgqiT8jZ9nS96Z',
  quote_json: CONTRACT_QUOTE_JSON,
  signature_base64: CONTRACT_SIGNATURE,
  msg: `{"quote":${JSON.stringify(CONTRACT_QUOTE_JSON)},"signature":"${CONTRACT_SIGNATURE}"}`,
};

/** Verifies with node:crypto, independently of near-api-js. */
function nodeVerify(publicKey: string, message: Uint8Array, signatureBase64: string): boolean {
  const raw = baseDecode(publicKey.slice('ed25519:'.length));
  const key = createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), raw]), format: 'der', type: 'spki' });
  return verify(null, message, key, Buffer.from(signatureBase64, 'base64'));
}

describe('packages/fixtures/near/vectors.json', () => {
  it('matches the generator (run `npm run near:vectors` after changing a format)', async () => {
    expect(readFileSync(VECTORS_PATH, 'utf8')).toBe(await renderNearVectors());
  });

  it('derives the implicit account from the public key', () => {
    expect(implicitAccountOf(vectors.keys.payer.public_key)).toBe(vectors.keys.payer.account_id);
  });

  it('NEP-413: the hash is sha256(borsh(2^31 + 413) ‖ borsh(payload)), signed with ed25519', () => {
    const { nep413 } = vectors;
    const nonce = Buffer.from(nep413.nonce_hex, 'hex');
    const utf8 = (s: string) => Buffer.from(s, 'utf8');
    const u32 = (n: number) => {
      const b = Buffer.alloc(4);
      b.writeUInt32LE(n);
      return b;
    };
    // Written out by hand: tag, message (len + bytes), nonce [32], recipient (len + bytes), callback_url None.
    const bytes = Buffer.concat([
      u32(2 ** 31 + 413),
      u32(utf8(nep413.message).length),
      utf8(nep413.message),
      nonce,
      u32(utf8(nep413.recipient).length),
      utf8(nep413.recipient),
      Buffer.from([0]),
    ]);
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(nep413.hash_hex);
    expect(nodeVerify(nep413.public_key, Buffer.from(nep413.hash_hex, 'hex'), nep413.signature_base64)).toBe(true);
    const signature = Buffer.from(nep413.signature_base64, 'base64');
    expect(verifyNep413({ message: nep413.message, nonce, recipient: nep413.recipient }, nep413.public_key, signature)).toBe(true);
    expect(verifyNep413({ message: nep413.message, nonce, recipient: 'evil.example' }, nep413.public_key, signature)).toBe(false);
  });

  it("quote: ed25519 over the quote JSON's UTF-8 bytes, byte for byte contracts-near's fixture", () => {
    const { quote, keys } = vectors;
    expect(nodeVerify(keys.quote_signer.public_key, Buffer.from(quote.quote_json, 'utf8'), quote.signature_base64)).toBe(true);
    // From contracts-near/settlement/tests/fixtures/quote.json (made by that workstream's make_quote.mjs with
    // the same RFC 8032 seed): NearQuoteSigner and nearTransferMsg must reproduce it exactly.
    expect(keys.quote_signer.public_key).toBe(CONTRACT_FIXTURE.quote_signer_public_key);
    expect(quote.quote_json).toBe(CONTRACT_FIXTURE.quote_json);
    expect(quote.signature_base64).toBe(CONTRACT_FIXTURE.signature_base64);
    expect(quote.msg).toBe(CONTRACT_FIXTURE.msg);
  });

  it('delegate: sha256(borsh(2^30 + 366) ‖ borsh(DelegateAction)), and the backend accepts it', () => {
    const { delegate, quote } = vectors;
    const encoded = Buffer.from(delegate.encoded_hex, 'hex');
    expect(encoded.readUInt32LE(0)).toBe(2 ** 30 + 366);
    expect(createHash('sha256').update(encoded).digest('hex')).toBe(delegate.hash_hex);
    expect(nodeVerify(delegate.public_key, Buffer.from(delegate.hash_hex, 'hex'), delegate.signature_base64)).toBe(true);
    // The sender_id string follows the prefix: u32 length, then the bytes.
    expect(encoded.readUInt32LE(4)).toBe(64);
    expect(encoded.subarray(8, 72).toString('utf8')).toBe(delegate.sender_id);

    const signed = checkSignedDelegate(delegate.signed_delegate_base64, {
      payer: delegate.sender_id,
      usdcContract: delegate.receiver_id,
      settlementContract: 'settlement.testnet',
      tokenAmount: 2_850_000n,
      msg: quote.msg,
      currentHeight: 190_000_000n,
    });
    expect(Buffer.from(signed.delegateAction.actions[0]!.functionCall!.args).toString('utf8')).toBe(delegate.args_json);
  });
});
