import 'dart:typed_data';

import 'package:blockchain_utils/blockchain_utils.dart';
import 'package:globalpay/services/wallet/near/borsh.dart';

/// NEP-413's signing prefix: 2^31 + 413, so a signed message can never be a transaction or a delegate action.
const nep413Prefix = 2147484061;

const _ed25519Prefix = 'ed25519:';

/// `ed25519:<base58>` for a raw 32-byte ed25519 public key.
String nearPublicKeyString(List<int> publicKey) {
  _checkLength(publicKey);
  return '$_ed25519Prefix${Base58Encoder.encode(publicKey)}';
}

/// The raw 32 bytes of an `ed25519:<base58>` public key. Throws a [FormatException] otherwise.
List<int> parseNearPublicKey(String value) {
  if (!value.startsWith(_ed25519Prefix)) throw FormatException('Not an ed25519 public key', value);
  final List<int> bytes;
  try {
    bytes = Base58Decoder.decode(value.substring(_ed25519Prefix.length));
  } on Object {
    throw FormatException('Not an ed25519 public key', value);
  }
  if (bytes.length != 32) throw FormatException('Not an ed25519 public key', value);
  return bytes;
}

/// The implicit account id of a key: its 32 bytes as lowercase hex. The account exists once it holds NEAR.
String implicitAccountId(List<int> publicKey) {
  _checkLength(publicKey);
  return BytesUtils.toHexString(publicKey, lowerCase: true);
}

/// borsh `PublicKey::ED25519`: key type 0, then the 32 bytes.
void writeEd25519PublicKey(BorshWriter writer, List<int> publicKey) {
  _checkLength(publicKey);
  writer
    ..u8(0)
    ..fixedBytes(publicKey);
}

/// What a NEP-413 signature signs: `sha256(u32 nep413Prefix ‖ borsh(Payload))`, where the payload is
/// `{message: String, nonce: [u8; 32], recipient: String, callback_url: Option<String>}`.
Uint8List nep413Digest({
  required String message,
  required List<int> nonce,
  required String recipient,
  String? callbackUrl,
}) {
  if (nonce.length != 32) throw ArgumentError.value(nonce.length, 'nonce', 'must be 32 bytes');
  final writer = BorshWriter()
    ..u32(nep413Prefix)
    ..string(message)
    ..fixedBytes(nonce)
    ..string(recipient)
    ..optionalString(callbackUrl);
  return Uint8List.fromList(QuickCrypto.sha256Hash(writer.toBytes()));
}

void _checkLength(List<int> publicKey) {
  if (publicKey.length != 32) throw ArgumentError.value(publicKey.length, 'publicKey', 'must be 32 bytes');
}
