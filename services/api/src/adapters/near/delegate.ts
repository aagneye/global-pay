import { createHash } from 'node:crypto';
import { type SignedDelegate, decodeSignedDelegate, encodeDelegateAction } from 'near-api-js';
import { AppError } from '../../shared/errors.js';
import { decodeBase64, implicitAccountOf, verifyEd25519 } from './keys.js';

/**
 * NEP-366 meta transactions: the user signs a DelegateAction, the relayer submits it and pays the gas.
 *
 *   signed bytes = sha256( borsh(u32 2^30 + 366) ‖ borsh(DelegateAction{ sender_id, receiver_id, actions,
 *                                                                      nonce, max_block_height, public_key }) )
 *
 * `encodeDelegateAction` writes the prefix and the action, so its sha256 is what the signature signs.
 */

/** What the delegate action must be, for the quote it pays. */
export interface ExpectedNearPayment {
  /** The quote's payer: the delegate's sender, whose own (implicit) key must have signed. */
  payer: string;
  usdcContract: string;
  settlementContract: string;
  tokenAmount: bigint;
  /** The `msg` this quote produced (`nearTransferMsg`). */
  msg: string;
  /** Height of the latest final block: the delegate must still be valid after it. */
  currentHeight: bigint;
}

export const FT_TRANSFER_CALL = 'ft_transfer_call';

/**
 * Decodes the base64 SignedDelegate and checks it pays exactly this quote: sender, key, receiver, one
 * `ft_transfer_call` with 1 yoctoNEAR to the settlement contract for the quote's amount and msg, a valid
 * signature, and a block height that hasn't passed. Throws 422 `invalid_authorization` naming the problem.
 * The args JSON is parsed and compared field by field, never byte for byte.
 */
export function checkSignedDelegate(signedDelegateBase64: string, expected: ExpectedNearPayment): SignedDelegate {
  const refuse = (reason: string): never => {
    throw new AppError('invalid_authorization', `The signed delegate doesn't pay this quote: ${reason}`, 422);
  };

  const bytes = decodeBase64(signedDelegateBase64);
  if (!bytes) refuse('signedDelegate is not base64');
  let signed: SignedDelegate;
  try {
    signed = decodeSignedDelegate(bytes as Uint8Array);
  } catch {
    return refuse('signedDelegate is not a borsh SignedDelegate');
  }
  const action = signed.delegateAction;

  if (action.senderId !== expected.payer) refuse(`sender ${action.senderId} is not the payer`);
  const publicKey = action.publicKey.toString();
  if (implicitAccountOf(publicKey) !== action.senderId) refuse("the key is not the sender's implicit account key");
  if (action.receiverId !== expected.usdcContract) refuse(`receiver ${action.receiverId} is not the USDC contract`);
  if (action.actions.length !== 1) refuse('expected exactly one action');
  const call = action.actions[0]?.functionCall;
  if (!call) return refuse('the action is not a function call');
  if (call.methodName !== FT_TRANSFER_CALL) refuse(`method ${call.methodName} is not ${FT_TRANSFER_CALL}`);
  if (BigInt(call.deposit) !== 1n) refuse('the deposit must be exactly 1 yoctoNEAR');

  let args: unknown;
  try {
    args = JSON.parse(Buffer.from(call.args).toString('utf8'));
  } catch {
    return refuse('the arguments are not JSON');
  }
  const { receiver_id: receiverId, amount, msg } = (args ?? {}) as Record<string, unknown>;
  if (receiverId !== expected.settlementContract) refuse('receiver_id is not the settlement contract');
  if (amount !== expected.tokenAmount.toString()) refuse(`amount ${String(amount)} is not the quote's ${expected.tokenAmount}`);
  if (msg !== expected.msg) refuse("msg is not this quote's");

  const hash = createHash('sha256').update(encodeDelegateAction(action)).digest();
  if (!verifyEd25519(publicKey, hash, signed.signature.data)) refuse('the signature is invalid');
  if (BigInt(action.maxBlockHeight) <= expected.currentHeight) refuse('it expired (max_block_height has passed)');
  return signed;
}
