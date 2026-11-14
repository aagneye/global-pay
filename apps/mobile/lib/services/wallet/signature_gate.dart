import 'dart:convert';

import 'package:blockchain_utils/blockchain_utils.dart';
import 'package:globalpay/core/errors/app_exception.dart';
import 'package:globalpay/core/storage/secure_store.dart';
import 'package:globalpay/services/tap/tap_services.dart';

/// Asks for the user's fingerprint before a wallet signs (ADR 0003). The Privy wallet uses it, because
/// Privy itself signs without one.
abstract interface class SignatureGate {
  /// Returns once the user has passed the check with [reason] on screen. Otherwise it throws:
  /// - `biometric_cancelled`: the user backed out;
  /// - `biometric_failed`: the check failed;
  /// - `biometric_unavailable`: no strong fingerprint (or face) is set up on this phone;
  /// - `biometric_reset`: the phone's fingerprints changed, so the user must sign in with their email again.
  Future<void> confirm(String reason);

  /// Called after a fresh email sign-in: the next [confirm] starts a new check, and a reset is lifted.
  Future<void> startOver();
}

/// A [SignatureGate] that the phone's hardware enforces, through the fingerprint vault ([KeyVault]).
///
/// A bare biometric prompt (what `local_auth` shows) only reports "passed", and a tampered app can fake
/// that report. Here each check must decrypt a random token sealed by a Keystore key that the hardware
/// releases only after a strong biometric, and the token must match the stored digest.
///
/// The first check seals a new token, which itself needs the fingerprint. If fingerprints are added or
/// removed, Android destroys the key. The gate then stays locked until the user signs in with an email
/// code again, so someone who knows the phone's PIN can't add their own fingerprint and pay.
class FingerprintGate implements SignatureGate {
  FingerprintGate({required KeyVault? vault, required SecureStore store, required bool requireBiometrics})
    : _vault = vault,
      _store = store,
      _requireBiometrics = requireBiometrics;

  static const sealedKey = 'signature_gate_sealed';
  static const digestKey = 'signature_gate_digest';
  static const lockedKey = 'signature_gate_locked';

  static const unavailable = AppException(
    'biometric_unavailable',
    "Set up a fingerprint in your phone's settings to approve payments.",
  );

  static const reset = AppException(
    'biometric_reset',
    'Your fingerprint settings changed. To keep your wallet safe, sign out and sign in again with your email.',
  );

  final KeyVault? _vault;
  final SecureStore _store;

  /// False only in debug builds, so emulators without a fingerprint can still sign.
  final bool _requireBiometrics;

  @override
  Future<void> confirm(String reason) async {
    if (await _store.read(lockedKey) != null) throw reset;

    final vault = _vault;
    if (vault == null || !await vault.isAvailable()) {
      if (_requireBiometrics) throw unavailable;
      return;
    }

    final sealed = await _store.read(sealedKey);
    final digest = await _store.read(digestKey);
    if (sealed == null || digest == null) return _enrol(vault, reason);

    final String token;
    try {
      token = await vault.open(sealed, reason: reason);
    } on AppException catch (error) {
      if (error.code != 'biometric_invalidated') rethrow;
      await _lock();
      throw reset;
    }
    // A token that doesn't match was tampered with or damaged: treat it like changed fingerprints.
    if (_digest(token) != digest) {
      await _lock();
      throw reset;
    }
  }

  @override
  Future<void> startOver() async {
    await _store.delete(sealedKey);
    await _store.delete(digestKey);
    await _store.delete(lockedKey);
  }

  /// Seals a new random token. Only its sealed form and its digest are stored.
  Future<void> _enrol(KeyVault vault, String reason) async {
    final token = BytesUtils.toHexString(QuickCrypto.generateRandom());
    final sealed = await vault.seal(token, reason: reason);
    await _store.write(sealedKey, sealed);
    await _store.write(digestKey, _digest(token));
  }

  Future<void> _lock() async {
    await _store.delete(sealedKey);
    await _store.delete(digestKey);
    await _store.write(lockedKey, '1');
  }

  static String _digest(String token) => BytesUtils.toHexString(QuickCrypto.sha256Hash(utf8.encode(token)));
}
