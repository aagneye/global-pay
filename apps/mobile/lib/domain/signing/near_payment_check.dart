/// Checks a NEAR meta transaction before the wallet signs it (NEAR rail).
///
/// The backend builds the `ft_transfer_call` the wallet signs. A compromised or buggy backend could ask for a
/// transfer of another token, to someone else, for more, or with a quote that pays a different payment. So, like
/// `authorization_check.dart` on EVM, the app compares it with what the screen shows and with its own settings
/// first, and refuses to sign anything that doesn't match.
library;

import 'dart:convert';

import 'package:globalpay/domain/models/quote.dart';
import 'package:globalpay/domain/signing/authorization_check.dart';

/// The most gas a payment may ask for: 300 Tgas, NEAR's limit for one function call.
final maxNearPaymentGas = BigInt.from(300) * BigInt.from(10).pow(12);

/// The furthest ahead a NEAR quote may expire. Quotes last at most 5 minutes (QUOTE_TTL_SECONDS).
const maxNearQuoteLifetime = Duration(minutes: 15);

/// A merchant payment on NEAR: [Quote.nearPayment] must be an `ft_transfer_call` with 1 yoctonear, signed by
/// [account] with [publicKey], sending exactly the quote's amount of [usdcContract] to [settlementContract]
/// (each checked when set), with reasonable gas, and carrying this quote (its ID, payer, token and amount)
/// expiring within [maxNearQuoteLifetime].
///
/// Throws an `AppException` ([authorizationMismatchCode]) naming what doesn't match.
void checkNearPayment(
  Quote quote, {
  required String account,
  required String publicKey,
  String? usdcContract,
  String? settlementContract,
  required DateTime now,
}) {
  final payment = quote.nearPayment ?? (throw authorizationMismatch('the kind of payment'));
  if (payment.methodName != 'ft_transfer_call') throw authorizationMismatch('the kind of payment');
  _expectAccount(payment.receiverId, usdcContract, 'the token');
  _expectAccount(payment.args.receiverId, settlementContract, 'the recipient');
  if (_uint(payment.args.amount) != quote.tokenAmount.units) throw authorizationMismatch('the amount');
  if (payment.signerId != account || payment.publicKey != publicKey) throw authorizationMismatch('your wallet');
  if (payment.deposit != '1') throw authorizationMismatch('the deposit');
  final gas = _uint(payment.gas);
  if (gas == null || gas == BigInt.zero || gas > maxNearPaymentGas) throw authorizationMismatch('the gas');
  if (!_isU64(payment.nonce) || !_isU64(payment.maxBlockHeight)) throw authorizationMismatch('the time limit');

  final signed = _signedQuote(payment.args.msg);
  if (signed['quote_id'] != quote.quoteId) throw authorizationMismatch('the payment ID');
  if (signed['payer'] != account) throw authorizationMismatch('your wallet');
  if (signed['token'] != payment.receiverId) throw authorizationMismatch('the token');
  if (signed['token_amount'] != payment.args.amount) throw authorizationMismatch('the amount');
  final expiresAt = signed['expires_at_ms'];
  final nowMs = now.millisecondsSinceEpoch;
  if (expiresAt is! int || expiresAt <= nowMs || expiresAt > nowMs + maxNearQuoteLifetime.inMilliseconds) {
    throw authorizationMismatch('the time limit');
  }
}

/// [actual] is [expected] when the app knows it; otherwise any account id.
void _expectAccount(String actual, String? expected, String what) {
  if (expected != null && expected.isNotEmpty ? actual != expected : actual.isEmpty) {
    throw authorizationMismatch(what);
  }
}

/// The quote inside `ft_transfer_call`'s msg: `{"quote": "<quote JSON>", "signature": "<base64>"}`, the quote
/// JSON as a string (exactly the bytes the backend signed).
Map<String, Object?> _signedQuote(String msg) {
  try {
    final outer = jsonDecode(msg);
    if (outer is Map<String, Object?> && outer['quote'] is String && outer['signature'] is String) {
      final quote = jsonDecode(outer['quote']! as String);
      if (quote is Map<String, Object?>) return quote;
    }
  } on FormatException {
    // Falls through to the refusal.
  }
  throw authorizationMismatch('the quote');
}

final _decimal = RegExp(r'^(0|[1-9][0-9]*)$');
final _u64Max = (BigInt.one << 64) - BigInt.one;

BigInt? _uint(String value) => _decimal.hasMatch(value) ? BigInt.parse(value) : null;

bool _isU64(String value) => switch (_uint(value)) {
  final number? => number <= _u64Max,
  null => false,
};
