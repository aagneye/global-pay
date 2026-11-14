/// Checks what the wallet is asked to sign, before it signs it.
///
/// The backend builds the EIP-712 typed data for both kinds of payment. A compromised or buggy backend
/// could ask the payer to sign a different transfer: to someone else, for more, on another chain or token.
/// So before every signature the app compares the typed data with what the screen shows and with its own
/// settings, and refuses to sign anything that doesn't match.
library;

import 'package:globalpay/core/errors/app_exception.dart';
import 'package:globalpay/domain/models/p2p.dart';
import 'package:globalpay/domain/models/quote.dart';

/// The [AppException.code] of a refusal.
const authorizationMismatchCode = 'authorization_mismatch';

/// The longest a merchant payment's authorisation may stay valid. Quotes last at most 5 minutes
/// (the backend's QUOTE_TTL_SECONDS), and the authorisation expires with the quote.
const maxQuoteAuthorizationLifetime = Duration(minutes: 15);

/// The longest a tap payment's authorisation may stay valid. The backend uses 10 minutes by default
/// (P2P_AUTHORIZATION_TTL_MS).
const maxTapAuthorizationLifetime = Duration(hours: 1);

/// EIP-3009's ReceiveWithAuthorization and TransferWithAuthorization, field by field.
const _eip3009Fields = [
  ('from', 'address'),
  ('to', 'address'),
  ('value', 'uint256'),
  ('validAfter', 'uint256'),
  ('validBefore', 'uint256'),
  ('nonce', 'bytes32'),
];

/// USDC's EIP-712 domain.
const _domainFields = [
  ('name', 'string'),
  ('version', 'string'),
  ('chainId', 'uint256'),
  ('verifyingContract', 'address'),
];

/// A merchant payment: a USDC `ReceiveWithAuthorization` from [wallet], on [chainId], for exactly the quote's
/// token and amount, with the quote ID as its nonce, expiring soon. The recipient must be [settlement] when the
/// app knows it (SETTLEMENT_ADDRESS); empty or null skips that check.
///
/// Throws an [AppException] ([authorizationMismatchCode]) naming what doesn't match.
void checkQuoteAuthorization(
  Quote quote, {
  required String wallet,
  required int chainId,
  String? settlement,
  required DateTime now,
}) {
  final (:domain, :message) = _structure(quote.authorization.typedData, 'ReceiveWithAuthorization');
  _expectChain(domain, chainId);
  _expectAddress(domain['verifyingContract'], quote.token, 'the token');
  _expectAddress(message['from'], wallet, 'your wallet');
  if (settlement != null && settlement.isNotEmpty) {
    _expectAddress(message['to'], settlement, 'the recipient');
  } else if (_address(message['to']) == null) {
    throw _mismatch('the recipient');
  }
  _expectUint(message['value'], quote.tokenAmount.units, 'the amount');
  _expectBytes32(message['nonce'], quote.quoteId, 'the payment ID');
  _expectValidity(message, now, maxQuoteAuthorizationLifetime);
}

/// A tap payment: a USDC `TransferWithAuthorization` of [typedData], from [wallet], on [chainId], to the
/// recipient and for the amount that [request] shows, in the request's token, expiring soon.
///
/// Throws an [AppException] ([authorizationMismatchCode]) naming what doesn't match.
void checkTapAuthorization(
  Map<String, Object?> typedData,
  P2pRequest request, {
  required String wallet,
  required int chainId,
  required DateTime now,
}) {
  final (:domain, :message) = _structure(typedData, 'TransferWithAuthorization');
  _expectChain(domain, chainId);
  _expectAddress(domain['verifyingContract'], request.token, 'the token');
  _expectAddress(message['from'], wallet, 'your wallet');
  _expectAddress(message['to'], request.recipientAddress, 'the recipient');
  _expectUint(message['value'], request.amount.units, 'the amount');
  if (_bytes32(message['nonce']) == null) throw _mismatch('the payment ID');
  _expectValidity(message, now, maxTapAuthorizationLifetime);
}

AppException _mismatch(String what) => AppException(
  authorizationMismatchCode,
  "Stopped before signing: what GlobalPay asked your wallet to sign doesn't match this payment ($what). "
  'Nothing was signed.',
);

/// The primary type is [primaryType] with exactly EIP-3009's fields, and nothing else could change the hash.
({Map<Object?, Object?> domain, Map<Object?, Object?> message}) _structure(
  Map<String, Object?> typedData,
  String primaryType,
) {
  const what = 'the kind of authorisation';
  final types = typedData['types'];
  final domain = typedData['domain'];
  final message = typedData['message'];
  if (typedData['primaryType'] != primaryType || types is! Map || domain is! Map || message is! Map) {
    throw _mismatch(what);
  }
  if (types.keys.any((name) => name != primaryType && name != 'EIP712Domain')) throw _mismatch(what);
  if (!_sameFields(types[primaryType], _eip3009Fields)) throw _mismatch(what);
  if (types.containsKey('EIP712Domain') && !_sameFields(types['EIP712Domain'], _domainFields)) throw _mismatch(what);
  if (domain.keys.any((key) => !_domainFields.any((field) => field.$1 == key))) throw _mismatch(what);
  return (domain: domain, message: message);
}

bool _sameFields(Object? fields, List<(String, String)> expected) {
  if (fields is! List || fields.length != expected.length) return false;
  for (var i = 0; i < expected.length; i++) {
    final field = fields[i];
    if (field is! Map || field['name'] != expected[i].$1 || field['type'] != expected[i].$2) return false;
  }
  return true;
}

void _expectChain(Map<Object?, Object?> domain, int chainId) {
  if (_uint(domain['chainId']) != BigInt.from(chainId)) throw _mismatch('the network');
}

void _expectAddress(Object? actual, String expected, String what) {
  final address = _address(actual);
  if (address == null || address != _address(expected)) throw _mismatch(what);
}

void _expectUint(Object? actual, BigInt expected, String what) {
  if (_uint(actual) != expected) throw _mismatch(what);
}

void _expectBytes32(Object? actual, String expected, String what) {
  final value = _bytes32(actual);
  if (value == null || value != _bytes32(expected)) throw _mismatch(what);
}

/// Usable now, and expiring within [maxLifetime]: not an authorisation that stays valid for years.
void _expectValidity(Map<Object?, Object?> message, DateTime now, Duration maxLifetime) {
  final validAfter = _uint(message['validAfter']);
  final validBefore = _uint(message['validBefore']);
  final seconds = BigInt.from(now.millisecondsSinceEpoch ~/ 1000);
  if (validAfter == null || validBefore == null || validAfter > seconds) throw _mismatch('the time limit');
  if (validBefore <= seconds || validBefore > seconds + BigInt.from(maxLifetime.inSeconds)) {
    throw _mismatch('the time limit');
  }
}

final _addressPattern = RegExp(r'^0x[0-9a-fA-F]{40}$');
final _bytes32Pattern = RegExp(r'^0x[0-9a-fA-F]{64}$');
final _decimalPattern = RegExp(r'^[0-9]+$');
final _hexPattern = RegExp(r'^0x[0-9a-fA-F]+$');

/// Lower-cased, so checksummed and plain addresses compare equal. Null if not an address.
String? _address(Object? value) => value is String && _addressPattern.hasMatch(value) ? value.toLowerCase() : null;

String? _bytes32(Object? value) => value is String && _bytes32Pattern.hasMatch(value) ? value.toLowerCase() : null;

/// An unsigned integer given as a number, a decimal string or a 0x hex string. Null otherwise.
BigInt? _uint(Object? value) => switch (value) {
  int() when value >= 0 => BigInt.from(value),
  BigInt() when value >= BigInt.zero => value,
  String() when _decimalPattern.hasMatch(value) => BigInt.parse(value),
  String() when _hexPattern.hasMatch(value) => BigInt.parse(value.substring(2), radix: 16),
  _ => null,
};
