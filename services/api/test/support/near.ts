import { createHash } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { type KeyPair, KeyPairSigner, PublicKey, actions, buildDelegateAction, encodeSignedDelegate } from 'near-api-js';
import { keyPairFromSeed } from '../../src/adapters/near/keys.js';

/**
 * Deterministic ed25519 test keys, derived from a label (no funds anywhere, never use outside tests):
 * the seed is sha256("globalpay-near-test:" + label).
 */
export function nearTestKey(label: string): KeyPair {
  return keyPairFromSeed(createHash('sha256').update(`globalpay-near-test:${label}`).digest());
}

export function implicitAccount(key: KeyPair): string {
  return Buffer.from(key.getPublicKey().data).toString('hex');
}

export const NEAR = {
  usdc: 'gp-test01-usdc.testnet',
  settlement: 'gp-test01-settle.testnet',
  relayer: 'gp-test01-relayer.testnet',
  payerKey: nearTestKey('payer'),
  quoteSignerKey: nearTestKey('quote-signer'),
  relayerKey: nearTestKey('relayer'),
};

/** Settings for buildTestApp: the NEAR rail with the test accounts and keys. */
export function nearEnv(overrides: Record<string, string> = {}): Record<string, string> {
  return {
    SETTLEMENT_RAIL: 'near',
    NEAR_SETTLEMENT_CONTRACT: NEAR.settlement,
    NEAR_USDC_CONTRACT: NEAR.usdc,
    NEAR_RELAYER_ACCOUNT_ID: NEAR.relayer,
    NEAR_RELAYER_PRIVATE_KEY: NEAR.relayerKey.toString(),
    NEAR_QUOTE_SIGNER_PRIVATE_KEY: NEAR.quoteSignerKey.toString(),
    ...overrides,
  };
}

/** Signs in through the HTTP API with NEP-413, as the app does on the NEAR rail. */
export async function nearSignIn(app: FastifyInstance, key: KeyPair = NEAR.payerKey) {
  const address = implicitAccount(key);
  const nonce = await app.inject({ method: 'POST', url: '/auth/nonce', payload: { address } });
  if (nonce.statusCode !== 200) throw new Error(`nonce failed: ${nonce.body}`);
  const { message, nonce: nonceHex } = nonce.json<{ message: string; nonce: string }>();
  const signed = await new KeyPairSigner(key).signNep413Message(address, {
    message,
    recipient: 'globalpay.local',
    nonce: Buffer.from(nonceHex, 'hex'),
  });
  const verify = await app.inject({
    method: 'POST',
    url: '/auth/verify',
    payload: { message, signature: Buffer.from(signed.signature).toString('base64'), publicKey: key.getPublicKey().toString() },
  });
  if (verify.statusCode !== 200) throw new Error(`sign-in failed: ${verify.body}`);
  const { token, user } = verify.json<{ token: string; user: { id: string } }>();
  return { token, userId: user.id, address, auth: { authorization: `Bearer ${token}` } };
}

export interface NearPaymentJson {
  signerId: string;
  publicKey: string;
  receiverId: string;
  methodName: string;
  args: { receiver_id: string; amount: string; msg: string };
  gas: string;
  deposit: string;
  nonce: string;
  maxBlockHeight: string;
}

/**
 * What the app does with `nearPayment`: a DelegateAction with one FunctionCall (args JSON in a fixed key
 * order), signed with the payer's key. Returns base64(borsh(SignedDelegate)). `change` tampers with it first.
 */
export async function signNearPayment(
  key: KeyPair,
  payment: NearPaymentJson,
  change: Partial<{ senderId: string; receiverId: string; methodName: string; args: object; deposit: bigint; maxBlockHeight: bigint; publicKey: PublicKey; extraAction: boolean }> = {},
): Promise<string> {
  const call = actions.functionCall(
    change.methodName ?? payment.methodName,
    change.args ?? { receiver_id: payment.args.receiver_id, amount: payment.args.amount, msg: payment.args.msg },
    BigInt(payment.gas),
    change.deposit ?? BigInt(payment.deposit),
  );
  const delegateAction = buildDelegateAction({
    senderId: change.senderId ?? payment.signerId,
    receiverId: change.receiverId ?? payment.receiverId,
    actions: change.extraAction ? [call, call] : [call],
    nonce: BigInt(payment.nonce),
    maxBlockHeight: change.maxBlockHeight ?? BigInt(payment.maxBlockHeight),
    publicKey: change.publicKey ?? PublicKey.fromString(payment.publicKey),
  });
  const { signedDelegate } = await new KeyPairSigner(key).signDelegateAction(delegateAction);
  return Buffer.from(encodeSignedDelegate(signedDelegate)).toString('base64');
}
