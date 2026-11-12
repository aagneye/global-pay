import 'dart:convert';
import 'dart:math';

import 'package:blockchain_utils/blockchain_utils.dart';
import 'package:on_chain/on_chain.dart';

/// Signs with a private key held in the app: EIP-191 `personal_sign` and EIP-712 `eth_signTypedData_v4`.
/// Signatures are deterministic (RFC 6979), so they match viem's byte for byte
/// (tested against packages/fixtures/wallet/vectors.json).
class LocalKeySigner {
  LocalKeySigner(String privateKeyHex) : _key = ETHPrivateKey(privateKeyHex);

  /// A new random key from the platform's secure random generator.
  factory LocalKeySigner.random() {
    final random = Random.secure();
    while (true) {
      final bytes = List<int>.generate(32, (_) => random.nextInt(256));
      try {
        return LocalKeySigner('0x${BytesUtils.toHexString(bytes)}');
      } on Exception {
        // Out of the curve's range: astronomically rare, try again.
      }
    }
  }

  final ETHPrivateKey _key;

  String get privateKeyHex => '0x${_key.toHex()}';

  /// Checksummed 0x address.
  String get address => _key.publicKey().toAddress().address;

  /// EIP-191 personal_sign over the UTF-8 message. Returns a 65-byte 0x signature (v = 27 or 28).
  String signMessage(String message) => '0x${BytesUtils.toHexString(_key.signPersonalMessage(utf8.encode(message)))}';

  /// EIP-712 v4 typed data, as JSON-like maps (numbers may be ints or decimal strings).
  String signTypedData(Map<String, Object?> typedData) {
    final digest = hashTypedData(typedData);
    return '0x${_key.sign(digest, hashMessage: false).toHex()}';
  }

  /// The EIP-712 digest that [signTypedData] signs.
  static List<int> hashTypedData(Map<String, Object?> typedData) {
    // Round-trip through JSON so nested maps and lists have the dynamic types the encoder expects.
    final json = jsonDecode(jsonEncode(typedData)) as Map<String, dynamic>;
    return Eip712TypedData.fromJson(json).encode();
  }
}
