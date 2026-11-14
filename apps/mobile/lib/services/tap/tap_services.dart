import 'dart:async';

import 'package:flutter/services.dart';
import 'package:globalpay/core/errors/app_exception.dart';
import 'package:globalpay/services/tap/tap_protocol.dart';
import 'package:nfc_manager/nfc_manager.dart';
import 'package:nfc_manager/nfc_manager_android.dart';

/// The sender's side: this phone answering taps, with a P-256 key that never leaves its hardware
/// keystore. Android only (host card emulation); see TapHostApduService.kt.
abstract interface class TapCard {
  /// Whether this phone can act as a contactless card.
  Future<bool> isSupported();

  /// The hardware key's public half (SPKI DER, base64), created on first use.
  Future<String> publicKey();

  /// The ID the backend gave this phone, announced when tapped.
  Future<void> setDeviceId(String deviceId);

  /// Answers taps for [duration]: only while the "Pay by tap" screen is open.
  Future<void> arm(Duration duration);

  Future<void> disarm();
}

class ChannelTapCard implements TapCard {
  const ChannelTapCard();

  static const _channel = MethodChannel('globalpay/tap_card');

  @override
  Future<bool> isSupported() async => await _channel.invokeMethod<bool>('isSupported') ?? false;

  @override
  Future<String> publicKey() async => (await _channel.invokeMethod<String>('publicKey'))!;

  @override
  Future<void> setDeviceId(String deviceId) => _channel.invokeMethod('setDeviceId', {'deviceId': deviceId});

  @override
  Future<void> arm(Duration duration) => _channel.invokeMethod('arm', {'seconds': duration.inSeconds});

  @override
  Future<void> disarm() => _channel.invokeMethod('disarm');
}

/// What the other phone answered: its device ID and its signature over the challenge.
class TapAnswer {
  const TapAnswer({required this.deviceId, required this.signature});

  final String deviceId;
  final String signature;
}

/// The receiver's side: reading the other phone over NFC.
abstract interface class TapReader {
  Future<bool> isAvailable();

  /// Waits for the other phone, sends it [challengeHex] and returns its answer. [stop] cancels.
  Future<TapAnswer> read(String challengeHex);

  Future<void> stop();
}

class NfcTapReader implements TapReader {
  NfcTapReader();

  Completer<TapAnswer>? _pending;

  @override
  Future<bool> isAvailable() async {
    try {
      return await NfcManager.instance.isAvailable();
    } on Object {
      return false;
    }
  }

  @override
  Future<TapAnswer> read(String challengeHex) async {
    await stop();
    final completer = _pending = Completer<TapAnswer>();
    final challenge = TapProtocol.challengeBytes(challengeHex);
    await NfcManager.instance.startSession(
      pollingOptions: {NfcPollingOption.iso14443},
      onDiscovered: (tag) async {
        if (completer.isCompleted) return;
        try {
          final card = IsoDepAndroid.from(tag);
          if (card == null) throw const AppException('tap_no_app', "That isn't a phone with GlobalPay");
          await card.setTimeout(3000);
          final deviceId = TapProtocol.parseDeviceId(await card.transceive(TapProtocol.selectApdu()));
          final signature = TapProtocol.parseSignature(await card.transceive(TapProtocol.signApdu(challenge)));
          completer.complete(TapAnswer(deviceId: deviceId, signature: signature));
        } on AppException catch (error) {
          completer.completeError(error);
        } on Object catch (_) {
          completer.completeError(const AppException('tap_failed', 'Hold the phones together a little longer'));
        } finally {
          await NfcManager.instance.stopSession();
        }
      },
    );
    return completer.future;
  }

  @override
  Future<void> stop() async {
    final pending = _pending;
    _pending = null;
    if (pending != null && !pending.isCompleted) {
      pending.completeError(const AppException('tap_cancelled', 'Stopped'));
      try {
        await NfcManager.instance.stopSession();
      } on Object {
        // No session running.
      }
    }
  }
}

/// Keeps the wallet key encrypted by a hardware key that needs the user's fingerprint (or face) every
/// time it's used. Android only; see KeyVault.kt.
abstract interface class KeyVault {
  /// Whether strong biometrics are enrolled, so the vault can be used.
  Future<bool> isAvailable();

  /// Encrypts [secret]; asks for the fingerprint.
  Future<String> seal(String secret, {required String reason});

  /// Decrypts; asks for the fingerprint with [reason]. Throws `biometric_cancelled` if the user backs out.
  Future<String> open(String sealed, {required String reason});
}

class ChannelKeyVault implements KeyVault {
  const ChannelKeyVault();

  static const _channel = MethodChannel('globalpay/vault');

  @override
  Future<bool> isAvailable() async {
    try {
      return await _channel.invokeMethod<bool>('isAvailable') ?? false;
    } on MissingPluginException {
      return false;
    }
  }

  @override
  Future<String> seal(String secret, {required String reason}) => _run('seal', {'secret': secret, 'reason': reason});

  @override
  Future<String> open(String sealed, {required String reason}) => _run('open', {'sealed': sealed, 'reason': reason});

  Future<String> _run(String method, Map<String, String> args) async {
    try {
      return (await _channel.invokeMethod<String>(method, args))!;
    } on PlatformException catch (e) {
      throw AppException(e.code == 'cancelled' ? 'biometric_cancelled' : 'biometric_failed', e.message ?? 'Fingerprint check failed');
    }
  }
}

/// Bytes helper for tests and the protocol.
Uint8List bytes(List<int> values) => Uint8List.fromList(values);
