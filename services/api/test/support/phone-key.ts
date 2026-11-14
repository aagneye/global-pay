import { generateKeyPairSync, sign } from 'node:crypto';
import { type Hex, bytesToHex } from 'viem';
import { tapMessage } from '../../src/lib/p256.js';

/** A phone's hardware key, as Android's Keystore makes it: P-256, SPKI export, DER signatures. */
export function phoneKey(curve = 'prime256v1') {
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: curve });
  return {
    publicKey: publicKey.export({ format: 'der', type: 'spki' }).toString('base64'),
    /** What the phone answers over NFC when the receiver sends `challenge`. */
    signTap: (challenge: Hex) => bytesToHex(sign('sha256', tapMessage(challenge), privateKey)),
  };
}
