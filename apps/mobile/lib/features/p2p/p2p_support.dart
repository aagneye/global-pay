import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:globalpay/core/errors/app_exception.dart';
import 'package:globalpay/core/providers.dart';
import 'package:globalpay/features/auth/session_controller.dart';

/// The QR a receiver shows instead of a tap: the request ID and its one-time challenge.
String encodeRequestQr(String requestId, String challenge) =>
    Uri(scheme: 'globalpay', host: 'pay', queryParameters: {'r': requestId, 'c': challenge}).toString();

/// A scanned request QR, or null if [text] isn't one (e.g. it's a PromptPay QR).
({String id, String challenge})? parseRequestQr(String text) {
  final uri = Uri.tryParse(text.trim());
  if (uri == null || uri.scheme != 'globalpay' || uri.host != 'pay') return null;
  final id = uri.queryParameters['r'];
  final challenge = uri.queryParameters['c'];
  if (id == null || id.isEmpty || challenge == null || !RegExp(r'^0x[0-9a-fA-F]{64}$').hasMatch(challenge)) return null;
  return (id: id, challenge: challenge);
}

final _usdcAmount = RegExp(r'^\d+(\.\d{1,6})?$');

/// "5", "5.5" or "5.123456" USDC as base units (6 decimals). Null if invalid or not positive.
BigInt? parseUsdc(String text) {
  final value = text.trim();
  if (!_usdcAmount.hasMatch(value)) return null;
  final [whole, fraction] = [...value.split('.'), ''].take(2).toList();
  final units = BigInt.parse(whole + fraction.padRight(6, '0'));
  return units > BigInt.zero ? units : null;
}

/// Secure-storage keys: tap to pay was turned off for this phone ("This phone" in the home menu), and the
/// device ID the backend last gave it.
const tapToPayOffKey = 'tap_to_pay_off';
const tapDeviceIdKey = 'tap_device_id';

/// Registers this phone for tap to pay, once per run after sign-in: its hardware key, and its push
/// token if push is set up. Null when the phone can't act as a card (then only the QR works), when
/// tap to pay is turned off for it, or on the NEAR rail (no tap to pay). Failures are swallowed: tap to pay is
/// optional, and the next run tries again.
final deviceRegistrationProvider = FutureProvider<String?>((ref) async {
  final session = await ref.watch(sessionProvider.future);
  if (session == null || ref.read(appConfigProvider).isNear) return null;
  try {
    final card = ref.read(tapCardProvider);
    final store = ref.read(secureStoreProvider);
    if (await store.read(tapToPayOffKey) != null || !await card.isSupported()) return null;
    final push = ref.read(pushServiceProvider);
    try {
      await push.start();
    } on Object {
      // Push is a convenience: the sender's screen polls too.
    }
    final id = await ref.read(p2pRepositoryProvider).registerDevice(publicKey: await card.publicKey(), fcmToken: await push.token());
    await card.setDeviceId(id);
    await store.write(tapDeviceIdKey, id);
    return id;
  } on Object {
    return null;
  }
});

/// Turns tap to pay off for this phone (e.g. before giving it away), or back on. Off lasts across restarts.
final tapToPaySwitchProvider = Provider<TapToPaySwitch>(TapToPaySwitch.new);

class TapToPaySwitch {
  TapToPaySwitch(this._ref);

  final Ref _ref;

  Future<bool> isOff() async => await _ref.read(secureStoreProvider).read(tapToPayOffKey) != null;

  /// This phone's device ID: from this run's registration, or the last one if it failed this time.
  /// Null if the phone can't pay by tap, or tap to pay is off.
  Future<String?> deviceId() async =>
      await _ref.read(deviceRegistrationProvider.future) ?? await _ref.read(secureStoreProvider).read(tapDeviceIdKey);

  /// The backend stops accepting this phone's taps, the phone stops answering them, and it isn't
  /// registered again on the next start. Throws (changing nothing) if the backend can't be reached.
  Future<void> turnOff() async {
    final store = _ref.read(secureStoreProvider);
    final id = await deviceId();
    if (id != null) {
      try {
        await _ref.read(p2pRepositoryProvider).revokeDevice(id);
      } on AppException catch (error) {
        if (error.code != 'not_found') rethrow; // Already revoked.
      }
    }
    await store.write(tapToPayOffKey, 'true');
    await store.delete(tapDeviceIdKey);
    try {
      await _ref.read(tapCardProvider).disarm();
    } on Object {
      // Revoked: the backend refuses its taps anyway.
    }
    _ref.invalidate(deviceRegistrationProvider);
  }

  /// Registers this phone again. False if that failed (the next start tries again).
  Future<bool> turnOn() async {
    await _ref.read(secureStoreProvider).delete(tapToPayOffKey);
    _ref.invalidate(deviceRegistrationProvider);
    return await _ref.read(deviceRegistrationProvider.future) != null;
  }
}

/// Request IDs from push notifications, to open their approve screen.
final pushRequestsProvider = StreamProvider<String>((ref) => ref.watch(pushServiceProvider).requestIds);
