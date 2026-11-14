import { describe, expect, it } from 'vitest';
import { type ExpectedNearPayment, checkSignedDelegate } from '../src/adapters/near/delegate.js';
import { NEAR, type NearPaymentJson, implicitAccount, nearTestKey, signNearPayment } from './support/near.js';

const PAYER = implicitAccount(NEAR.payerKey);
const MSG = JSON.stringify({ quote: '{"quote_id":"0x01"}', signature: 'c2ln' });
const payment: NearPaymentJson = {
  signerId: PAYER,
  publicKey: NEAR.payerKey.getPublicKey().toString(),
  receiverId: NEAR.usdc,
  methodName: 'ft_transfer_call',
  args: { receiver_id: NEAR.settlement, amount: '3107693', msg: MSG },
  gas: '100000000000000',
  deposit: '1',
  nonce: '42',
  maxBlockHeight: '1300',
};
const expected: ExpectedNearPayment = {
  payer: PAYER,
  usdcContract: NEAR.usdc,
  settlementContract: NEAR.settlement,
  tokenAmount: 3_107_693n,
  msg: MSG,
  currentHeight: 1_000n,
};

describe('checkSignedDelegate', () => {
  it('accepts the delegate the app builds from nearPayment', async () => {
    const signed = checkSignedDelegate(await signNearPayment(NEAR.payerKey, payment), expected);
    expect(signed.delegateAction.senderId).toBe(PAYER);
  });

  it('accepts args JSON in another key order (fields are compared, not bytes)', async () => {
    const reordered = await signNearPayment(NEAR.payerKey, payment, { args: { msg: MSG, amount: '3107693', receiver_id: NEAR.settlement } });
    expect(() => checkSignedDelegate(reordered, expected)).not.toThrow();
  });

  const stranger = nearTestKey('stranger');
  const cases: [string, () => Promise<string>, RegExp][] = [
    ['another sender', () => signNearPayment(stranger, { ...payment, signerId: implicitAccount(stranger), publicKey: stranger.getPublicKey().toString() }), /is not the payer/],
    ["a key that isn't the sender's", () => signNearPayment(stranger, payment, { publicKey: stranger.getPublicKey() }), /implicit account key/],
    ['another receiver', () => signNearPayment(NEAR.payerKey, payment, { receiverId: 'evil.testnet' }), /not the USDC contract/],
    ['another method', () => signNearPayment(NEAR.payerKey, payment, { methodName: 'ft_transfer' }), /is not ft_transfer_call/],
    ['two actions', () => signNearPayment(NEAR.payerKey, payment, { extraAction: true }), /exactly one action/],
    ['a deposit other than 1 yocto', () => signNearPayment(NEAR.payerKey, payment, { deposit: 2n }), /exactly 1 yoctoNEAR/],
    ['another amount', () => signNearPayment(NEAR.payerKey, payment, { args: { ...payment.args, amount: '1' } }), /amount 1/],
    ['another settlement receiver', () => signNearPayment(NEAR.payerKey, payment, { args: { ...payment.args, receiver_id: 'evil.testnet' } }), /settlement contract/],
    ['another msg', () => signNearPayment(NEAR.payerKey, payment, { args: { ...payment.args, msg: '{}' } }), /msg/],
    ['args that are not JSON', () => signNearPayment(NEAR.payerKey, payment, { args: new TextEncoder().encode('nope') }), /not JSON/],
    [
      "someone else's signature",
      async () => {
        // Signed by the stranger, but naming the payer's key: only the signature check catches it.
        const forged = await signNearPayment(stranger, payment, { publicKey: stranger.getPublicKey() });
        const bytes = Buffer.from(forged, 'base64');
        const strangerKey = Buffer.from(stranger.getPublicKey().data);
        const at = bytes.indexOf(strangerKey);
        Buffer.from(NEAR.payerKey.getPublicKey().data).copy(bytes, at);
        return bytes.toString('base64');
      },
      /signature is invalid/,
    ],
    ['an expired block height', () => signNearPayment(NEAR.payerKey, payment, { maxBlockHeight: 1_000n }), /expired/],
  ];

  it.each(cases)('refuses %s', async (_name, build, reason) => {
    const signedDelegate = await build();
    expect(() => checkSignedDelegate(signedDelegate, expected)).toThrow(reason);
    try {
      checkSignedDelegate(signedDelegate, expected);
    } catch (error) {
      expect(error).toMatchObject({ code: 'invalid_authorization', statusCode: 422 });
    }
  });

  it('refuses bytes that are not a SignedDelegate', () => {
    expect(() => checkSignedDelegate('not base64!', expected)).toThrow(/not base64/);
    expect(() => checkSignedDelegate(Buffer.from('hello').toString('base64'), expected)).toThrow(/not a borsh SignedDelegate/);
  });
});
