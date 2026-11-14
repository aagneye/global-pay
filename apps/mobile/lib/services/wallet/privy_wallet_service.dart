import 'dart:convert';

import 'package:globalpay/core/errors/app_exception.dart';
import 'package:globalpay/services/wallet/privy_client.dart';
import 'package:globalpay/services/wallet/signature_gate.dart';
import 'package:globalpay/services/wallet/wallet_service.dart';

/// Embedded, non-custodial wallet through Privy (ADR 0003): users sign in with their email and a
/// one-time code and never handle a seed phrase. Privy secures the key; GlobalPay never holds it.
///
/// Signing in takes two steps before [connect]: [sendEmailCode], then [verifyEmailCode]. [connect] then
/// returns the user's embedded wallet (created on first use). While Privy's session lasts, later
/// launches reconnect without a code. Web3Auth is the fallback provider.
///
/// Every signature first passes the [SignatureGate]: the user's fingerprint, checked by the phone's
/// hardware. A fresh email sign-in starts that check over.
class PrivyWalletService implements WalletService {
  PrivyWalletService(this._client, {required SignatureGate gate}) : _gate = gate;

  final PrivyClient _client;
  final SignatureGate _gate;
  String? _address;

  static final _emailPattern = RegExp(r'^[^\s@]+@[^\s@]+\.[^\s@]+$');
  static final _signaturePattern = RegExp(r'^0x[0-9a-fA-F]{130}$');

  /// Step 1: emails a sign-in code. Signs out an earlier Privy user first, so the code is for this email.
  Future<void> sendEmailCode(String email) async {
    final address = email.trim();
    if (!_emailPattern.hasMatch(address)) throw const AppException('email_invalid', 'Enter a valid email address');
    await _guard(() async {
      if (await _client.isAuthenticated()) await _client.logout();
      _address = null;
      await _client.sendEmailCode(address);
    });
  }

  /// Step 2: signs in to Privy with the emailed code. Proving the email also starts the fingerprint
  /// check over, which lifts the lock left when the phone's fingerprints changed.
  Future<void> verifyEmailCode({required String email, required String code}) async {
    final trimmed = code.trim();
    if (trimmed.isEmpty) throw const AppException('email_code_invalid', 'Enter the code from the email');
    await _guard(() => _client.loginWithEmailCode(email: email.trim(), code: trimmed));
    await _gate.startOver();
  }

  @override
  Future<String> connect() => _guard(() async {
    if (!await _client.isAuthenticated()) {
      throw const PrivyClientException(PrivyFailure.notAuthenticated, 'Not signed in to Privy');
    }
    return _address = await _client.ethereumWallet();
  });

  @override
  Future<String?> currentAddress() async => _address;

  /// Signs out of Privy too, so the next sign-in asks for an email code again.
  @override
  Future<void> disconnect() async {
    _address = null;
    try {
      await _client.logout();
    } on PrivyClientException {
      // Signing out of GlobalPay must not fail; the next sendEmailCode signs Privy out again anyway.
    }
  }

  @override
  Future<String> signMessage(String message) =>
      _sign('Sign in to GlobalPay', (address) => _client.personalSign(address: address, message: message));

  @override
  Future<String> signTypedData(Map<String, Object?> typedData) => _sign(
    'Approve this payment',
    (address) => _client.signTypedDataV4(address: address, typedDataJson: jsonEncode(typedData)),
  );

  /// Asks for the fingerprint with [reason], then has Privy sign.
  Future<String> _sign(String reason, Future<String> Function(String address) sign) async {
    final address = _address ?? (throw const AppException('wallet_not_connected', 'Sign in to use your wallet'));
    await _gate.confirm(reason);
    final raw = (await _guard(() => sign(address))).trim();
    final signature = raw.startsWith('0x') ? raw : '0x$raw';
    if (!_signaturePattern.hasMatch(signature)) {
      throw const AppException('signature_failed', 'Your wallet returned an unexpected signature. Please try again.');
    }
    return signature;
  }

  static Future<T> _guard<T>(Future<T> Function() body) async {
    try {
      return await body();
    } on PrivyClientException catch (error) {
      throw appExceptionFor(error.failure);
    }
  }

  /// What the user sees for each kind of Privy failure.
  static AppException appExceptionFor(PrivyFailure failure) => switch (failure) {
    PrivyFailure.notAuthenticated => const AppException(
      'wallet_not_connected',
      'Sign in with your email to use your wallet',
    ),
    PrivyFailure.sendCode => const AppException(
      'email_code_not_sent',
      "We couldn't send a code to that email. Check the address and try again.",
    ),
    PrivyFailure.invalidCode => const AppException(
      'email_code_invalid',
      "That code didn't work. Check the email, or send a new code.",
    ),
    PrivyFailure.wallet => const AppException('wallet_unavailable', "We couldn't open your wallet. Please try again."),
    PrivyFailure.signing => const AppException('signature_failed', "Your wallet couldn't sign. Please try again."),
    PrivyFailure.timeout => const AppException(
      'wallet_timeout',
      'Your wallet took too long to answer. Check your connection and try again.',
    ),
    PrivyFailure.offline => const AppException(
      'wallet_offline',
      "Can't reach your wallet. Check your connection and try again.",
    ),
    PrivyFailure.unknown => const AppException(
      'wallet_error',
      'Something went wrong with your wallet. Please try again.',
    ),
  };
}
