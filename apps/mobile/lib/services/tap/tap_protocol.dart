import 'dart:convert';
import 'dart:typed_data';

import 'package:globalpay/core/errors/app_exception.dart';

/// What the two phones say over NFC (ADR 0010). The sender's phone acts as a contactless card with
/// GlobalPay's own application ID; the receiver's phone reads it:
///
///   1. SELECT the AID            → the sender's device ID (UTF-8), 90 00
///   2. SIGN (CLA 80, INS 10) + 32-byte challenge
///                                → ECDSA P-256 / SHA-256 signature (DER) over
///                                  "GLOBALPAY-TAP-1" ‖ challenge, 90 00
///
/// The phone answers only while its owner has the "Pay by tap" screen open (69 85 otherwise).
/// android/app/src/main/kotlin/.../TapHostApduService.kt is the other half and must match.
abstract final class TapProtocol {
  /// F0 (proprietary) "GPAY" 00 01.
  static final aid = Uint8List.fromList([0xF0, 0x47, 0x50, 0x41, 0x59, 0x00, 0x01]);

  static const _ok = 0x9000;
  static const _notReady = 0x6985;
  static const _unknownAid = 0x6A82;

  static Uint8List selectApdu() => Uint8List.fromList([0x00, 0xA4, 0x04, 0x00, aid.length, ...aid, 0x00]);

  static Uint8List signApdu(Uint8List challenge) {
    if (challenge.length != 32) throw ArgumentError.value(challenge.length, 'challenge', 'must be 32 bytes');
    return Uint8List.fromList([0x80, 0x10, 0x00, 0x00, 0x20, ...challenge, 0x00]);
  }

  /// The device ID from the SELECT response.
  static String parseDeviceId(Uint8List response) {
    final data = _data(response);
    if (data.isEmpty || data.length > 64) throw const AppException('tap_failed', 'The other phone sent an unexpected answer');
    return utf8.decode(data);
  }

  /// The signature from the SIGN response, as 0x hex.
  static String parseSignature(Uint8List response) {
    final data = _data(response);
    if (data.length < 8 || data.length > 72) throw const AppException('tap_failed', 'The other phone sent an unexpected answer');
    return '0x${data.map((b) => b.toRadixString(16).padLeft(2, '0')).join()}';
  }

  static Uint8List challengeBytes(String challengeHex) {
    final hex = challengeHex.startsWith('0x') ? challengeHex.substring(2) : challengeHex;
    if (hex.length != 64) throw ArgumentError.value(challengeHex, 'challengeHex', 'must be 32 bytes of hex');
    return Uint8List.fromList([for (var i = 0; i < 64; i += 2) int.parse(hex.substring(i, i + 2), radix: 16)]);
  }

  static Uint8List _data(Uint8List response) {
    if (response.length < 2) throw const AppException('tap_failed', 'The other phone sent an unexpected answer');
    final status = (response[response.length - 2] << 8) | response[response.length - 1];
    return switch (status) {
      _ok => Uint8List.sublistView(response, 0, response.length - 2),
      _notReady => throw const AppException('tap_not_ready', 'Ask them to open "Pay by tap" on their phone'),
      _unknownAid => throw const AppException('tap_no_app', "The other phone doesn't have GlobalPay"),
      _ => throw AppException('tap_failed', 'The other phone refused (${status.toRadixString(16)})'),
    };
  }
}
