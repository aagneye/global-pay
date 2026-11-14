import 'dart:async';

import 'package:globalpay/core/errors/app_exception.dart';
import 'package:globalpay/services/tap/tap_services.dart';

/// This phone as a card, without NFC hardware: records what the app asks of it.
class FakeTapCard implements TapCard {
  FakeTapCard({this.supported = true});

  final bool supported;
  String? deviceId;
  final arms = <Duration>[];
  int disarms = 0;

  @override
  Future<bool> isSupported() async => supported;

  @override
  Future<String> publicKey() async => 'MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEfakekey';

  @override
  Future<void> setDeviceId(String deviceId) async => this.deviceId = deviceId;

  @override
  Future<void> arm(Duration duration) async => arms.add(duration);

  @override
  Future<void> disarm() async => disarms++;
}

/// The receiver's NFC reader: answers like the other phone would, once, after [delay].
class FakeTapReader implements TapReader {
  FakeTapReader({this.delay = const Duration(milliseconds: 300)});

  final Duration delay;
  final challenges = <String>[];
  Completer<TapAnswer>? _pending;

  @override
  Future<bool> isAvailable() async => true;

  @override
  Future<TapAnswer> read(String challengeHex) {
    challenges.add(challengeHex);
    final pending = _pending = Completer<TapAnswer>();
    if (challenges.length == 1) {
      Timer(delay, () {
        if (!pending.isCompleted) pending.complete(const TapAnswer(deviceId: 'device_9', signature: '0x3044abcd'));
      });
    }
    return pending.future;
  }

  @override
  Future<void> stop() async {
    final pending = _pending;
    if (pending != null && !pending.isCompleted) pending.completeError(const AppException('tap_cancelled', 'Stopped'));
  }
}
