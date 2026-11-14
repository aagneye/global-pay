/// Parses Indian UPI QRs (`upi://pay?...`, NPCI's UPI linking spec). The backend checks the QR again before
/// quoting; this is for instant feedback and the confirm screen.
library;

import 'package:globalpay/domain/models/money.dart';
import 'package:globalpay/domain/models/upi_qr.dart';

class UpiParseException implements Exception {
  const UpiParseException(this.message);

  final String message;

  @override
  String toString() => 'UpiParseException: $message';
}

/// A UPI ID (VPA), as the backend checks it.
final upiVpaPattern = RegExp(r'^[A-Za-z0-9._-]{2,256}@[A-Za-z][A-Za-z0-9]{1,63}$');

final _amount = RegExp(r'^\d+(\.\d{1,2})?$');

/// Whether [payload] looks like a UPI QR (rather than PromptPay), so its errors are UPI's.
bool isUpiPayload(String payload) => payload.trim().toLowerCase().startsWith('upi:');

/// Parses a UPI QR. `pa` is required and must be a VPA; `cu` must be INR or absent; `am`, when present, is a
/// positive rupee amount with at most 2 decimals; `pn` is URL-decoded.
///
/// Throws a [UpiParseException] saying what's wrong.
UpiQr parseUpiQr(String payload) {
  final raw = payload.trim();
  final uri = Uri.tryParse(raw);
  if (uri == null || uri.scheme.toLowerCase() != 'upi' || uri.host.toLowerCase() != 'pay') {
    throw const UpiParseException('This is not a UPI payment QR.');
  }
  // Read parameters exactly as the backend does (services/api/src/lib/upi/parse.ts): names ignore case and
  // the first value of a repeated name wins. Otherwise a QR with `pa` twice could show one payee here while
  // the backend quotes and pays another.
  final params = <String, String>{};
  try {
    for (final MapEntry(:key, :value) in uri.queryParametersAll.entries) {
      final name = key.toLowerCase();
      if (value.isNotEmpty) params.putIfAbsent(name, () => value.first);
    }
  } on FormatException {
    throw const UpiParseException('This UPI QR is malformed.');
  }
  String? param(String key) => switch (params[key]?.trim()) {
    null || '' => null,
    final value => value,
  };

  final vpa = param('pa') ?? (throw const UpiParseException('This UPI QR has no UPI ID (pa).'));
  if (!upiVpaPattern.hasMatch(vpa)) throw UpiParseException('"$vpa" is not a valid UPI ID.');

  final currency = param('cu');
  if (currency != null && currency.toUpperCase() != 'INR') {
    throw UpiParseException('This UPI QR is in $currency. Only rupees (INR) are supported.');
  }

  FiatAmount? amount;
  if (param('am') case final am?) {
    if (!_amount.hasMatch(am)) throw UpiParseException('"$am" is not a valid amount.');
    final [whole, fraction] = [...am.split('.'), ''].take(2).toList();
    final minor = BigInt.parse(whole + fraction.padRight(2, '0'));
    if (minor <= BigInt.zero) throw const UpiParseException('The amount must be more than ₹0.');
    amount = FiatAmount(currency: FiatCurrency.inr, minor: minor);
  }

  return UpiQr(
    raw: raw,
    vpa: vpa,
    name: param('pn'),
    amount: amount,
    merchantCode: param('mc'),
    reference: param('tr'),
    note: param('tn'),
  );
}
