import 'package:globalpay/core/errors/app_exception.dart';
import 'package:globalpay/services/tap/tap_services.dart';
import 'package:globalpay/services/wallet/signature_gate.dart';

/// A vault that "encrypts" by reversing, and records each fingerprint prompt.
class FakeVault implements KeyVault {
  FakeVault({this.available = true});

  bool available;

  /// The reason shown by each prompt, sealing or opening.
  final prompts = <String>[];

  /// Each secret sealed.
  final secrets = <String>[];

  /// The user backs out of the next prompt.
  bool cancelNext = false;

  /// The phone's fingerprints changed: nothing sealed so far opens, until a new seal makes a new key.
  bool invalidated = false;

  @override
  Future<bool> isAvailable() async => available;

  @override
  Future<String> seal(String secret, {required String reason}) async {
    _prompt(reason);
    invalidated = false;
    secrets.add(secret);
    return secret.split('').reversed.join();
  }

  @override
  Future<String> open(String sealed, {required String reason}) async {
    if (invalidated) throw const AppException('biometric_invalidated', 'Your fingerprints changed');
    _prompt(reason);
    return sealed.split('').reversed.join();
  }

  void _prompt(String reason) {
    prompts.add(reason);
    if (cancelNext) {
      cancelNext = false;
      throw const AppException('biometric_cancelled', 'Cancelled');
    }
  }
}

/// A fingerprint check that passes unless told to fail, and records what it was asked.
class FakeGate implements SignatureGate {
  /// The reason given to each check.
  final reasons = <String>[];

  int startOvers = 0;

  /// The next check throws this.
  AppException? failNext;

  @override
  Future<void> confirm(String reason) async {
    reasons.add(reason);
    final failure = failNext;
    failNext = null;
    if (failure != null) throw failure;
  }

  @override
  Future<void> startOver() async => startOvers++;
}
