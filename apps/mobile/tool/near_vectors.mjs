// Writes test/fixtures/near_vectors.json: NEAR key, NEP-413 sign-in and NEP-366 delegate action vectors,
// produced by near-api-js so the app's own borsh and signing code is checked against an independent
// implementation (test/services/near_wallet_test.dart).
//
// near-api-js isn't a dependency of anything in the repo. Install it into a scratch folder and pass its
// node_modules:
//   npm i --prefix /tmp/nearjs near-api-js@7.5.3
//   node tool/near_vectors.mjs /tmp/nearjs/node_modules > test/fixtures/near_vectors.json
//
// TEST ONLY: the keys are RFC 8032's published ed25519 test vectors. Never use them for anything else.
import { createHash, createPublicKey, verify } from 'node:crypto';
import { createRequire } from 'node:module';
import { join } from 'node:path';

const modules = process.argv[2];
if (!modules) {
  console.error('usage: node tool/near_vectors.mjs <node_modules with near-api-js>');
  process.exit(2);
}
const require = createRequire(join(modules, 'noop.js'));
const near = require('near-api-js');
const borsh = require('borsh');

// RFC 8032 section 7.1, TEST 1 (the wallet) and TEST 2 (the backend's quote signer).
const walletSeed = Buffer.from('9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60', 'hex');
const quoteSignerSeed = Buffer.from('4ccd089b28ff96da9db6c346ec114e0f5b8a319f35aba624da8cf6ed4fb8a6fb', 'hex');

const signerFor = (seed) => {
  const publicKey = new near.KeyPairEd25519(near.baseEncode(new Uint8Array(seed))).getPublicKey().data;
  const keyPair = new near.KeyPairEd25519(near.baseEncode(new Uint8Array([...seed, ...publicKey])));
  return { keyPair, signer: new near.KeyPairSigner(keyPair), publicKey: Buffer.from(publicKey) };
};
const wallet = signerFor(walletSeed);
const quoteSigner = signerFor(quoteSignerSeed);
const publicKey = wallet.keyPair.getPublicKey().toString();
const accountId = wallet.publicKey.toString('hex');

const sha256 = (bytes) => createHash('sha256').update(bytes).digest();
const u32 = (value) => Buffer.from(borsh.serialize('u32', value));
const hex = (bytes) => Buffer.from(bytes).toString('hex');
const base64 = (bytes) => Buffer.from(bytes).toString('base64');

/// Checks an ed25519 signature with node:crypto, a third implementation.
const verified = (message, signature, rawPublicKey) => {
  const spki = Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), rawPublicKey]);
  return verify(null, message, createPublicKey({ key: spki, format: 'der', type: 'spki' }), signature);
};
const check = (ok, what) => {
  if (!ok) throw new Error(`self-check failed: ${what}`);
};

// NEP-413 sign-in.
const nep413 = {
  message: `globalpay.local wants you to sign in with your NEAR account:\n${accountId}\n\nPay any Thai QR — no gas.`,
  nonce: Buffer.alloc(32).map((_, i) => (i * 7 + 3) & 0xff),
  recipient: 'globalpay.local',
};
const signedMessage = await wallet.signer.signNep413Message(accountId, {
  message: nep413.message,
  nonce: new Uint8Array(nep413.nonce),
  recipient: nep413.recipient,
});
const nep413Digest = sha256(
  Buffer.concat([
    u32(2147484061),
    Buffer.from(
      borsh.serialize(
        {
          struct: {
            message: 'string',
            nonce: { array: { type: 'u8', len: 32 } },
            recipient: 'string',
            callbackUrl: { option: 'string' },
          },
        },
        { message: nep413.message, nonce: new Uint8Array(nep413.nonce), recipient: nep413.recipient, callbackUrl: null },
      ),
    ),
  ]),
);
check(signedMessage.publicKey.toString() === publicKey, 'NEP-413 public key');
check(verified(nep413Digest, Buffer.from(signedMessage.signature), wallet.publicKey), 'NEP-413 signature');

// The quote the backend signs, and the delegate action that pays it.
const usdc = 'usdc.globalpay.testnet';
const settlement = 'settle.globalpay.testnet';
const quoteJson = JSON.stringify({
  quote_id: '0xabababababababababababababababababababababababababababababababab',
  payer: accountId,
  token: usdc,
  token_amount: '7477454',
  fiat_currency: 'THB',
  fiat_amount: '25000',
  merchant_ref_hash: '0xf00693116400736b2592210681da6a3d56654b34f739487ff2dfd42ad12d0efc',
  expires_at_ms: 1763130000000,
});
const quoteSignature = quoteSigner.keyPair.sign(Buffer.from(quoteJson, 'utf8')).signature;
const nearPayment = {
  signerId: accountId,
  publicKey,
  receiverId: usdc,
  methodName: 'ft_transfer_call',
  args: {
    receiver_id: settlement,
    amount: '7477454',
    msg: JSON.stringify({ quote: quoteJson, signature: base64(quoteSignature) }),
  },
  gas: '100000000000000',
  deposit: '1',
  nonce: '190000000000001',
  maxBlockHeight: '187654321',
};
const delegateAction = near.buildDelegateAction({
  senderId: nearPayment.signerId,
  receiverId: nearPayment.receiverId,
  actions: [
    near.actions.functionCall(
      nearPayment.methodName,
      nearPayment.args,
      BigInt(nearPayment.gas),
      BigInt(nearPayment.deposit),
    ),
  ],
  nonce: BigInt(nearPayment.nonce),
  maxBlockHeight: BigInt(nearPayment.maxBlockHeight),
  publicKey: near.PublicKey.fromString(nearPayment.publicKey),
});
const { delegateHash, signedDelegate } = await wallet.signer.signDelegateAction(delegateAction);
const delegateBorsh = Buffer.from(borsh.serialize(near.SCHEMA.DelegateAction, delegateAction));
const signedDelegateBytes = Buffer.from(near.encodeSignedDelegate(signedDelegate));
const delegateSignature = Buffer.from(signedDelegate.signature.data);
check(hex(delegateHash) === hex(sha256(Buffer.concat([u32(1073742190), delegateBorsh]))), 'delegate digest');
check(hex(near.encodeDelegateAction(delegateAction)) === hex(Buffer.concat([u32(1073742190), delegateBorsh])), 'prefix');
check(verified(Buffer.from(delegateHash), delegateSignature, wallet.publicKey), 'delegate signature');
check(
  hex(signedDelegateBytes) === hex(Buffer.concat([delegateBorsh, Buffer.from([0]), delegateSignature])),
  'SignedDelegate layout',
);

const vectors = {
  _note:
    'TEST ONLY. Keys are RFC 8032 published ed25519 test vectors. Generated by apps/mobile/tool/near_vectors.mjs ' +
    'with near-api-js 7.5.3; do not edit by hand.',
  key: { seed: hex(walletSeed), publicKey, accountId },
  nep413: {
    message: nep413.message,
    nonce: hex(nep413.nonce),
    recipient: nep413.recipient,
    digest: hex(nep413Digest),
    signature: base64(signedMessage.signature),
  },
  delegate: {
    nearPayment,
    quoteJson,
    argsJson: Buffer.from(delegateAction.actions[0].functionCall.args).toString('utf8'),
    borsh: hex(delegateBorsh),
    digest: hex(delegateHash),
    signature: base64(delegateSignature),
    signedDelegate: base64(signedDelegateBytes),
  },
};
process.stdout.write(`${JSON.stringify(vectors, null, 2)}\n`);
