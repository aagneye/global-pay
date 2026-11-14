import 'package:flutter_riverpod/flutter_riverpod.dart';
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

/// Registers this phone for tap to pay, once per run after sign-in: its hardware key, and its push
/// token if push is set up. Null when the phone can't act as a card (then only the QR works).
/// Failures are swallowed: tap to pay is optional, and the next run tries again.
final deviceRegistrationProvider = FutureProvider<String?>((ref) async {
  final session = await ref.watch(sessionProvider.future);
  if (session == null) return null;
  try {
    final card = ref.read(tapCardProvider);
    if (!await card.isSupported()) return null;
    final push = ref.read(pushServiceProvider);
    try {
      await push.start();
    } on Object {
      // Push is a convenience: the sender's screen polls too.
    }
    final id = await ref.read(p2pRepositoryProvider).registerDevice(publicKey: await card.publicKey(), fcmToken: await push.token());
    await card.setDeviceId(id);
    return id;
  } on Object {
    return null;
  }
});

/// Request IDs from push notifications, to open their approve screen.
final pushRequestsProvider = StreamProvider<String>((ref) => ref.watch(pushServiceProvider).requestIds);
