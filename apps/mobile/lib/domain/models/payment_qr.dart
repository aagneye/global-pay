import 'package:globalpay/domain/models/money.dart';

/// A scanned QR the app can pay: a Thai PromptPay QR (฿) or an Indian UPI QR (₹).
abstract interface class PaymentQr {
  /// The original payload, sent to the backend for quoting.
  String get raw;

  /// What the payee is paid in.
  FiatCurrency get currency;

  /// Fixed by the QR (a dynamic QR), or null when the payer types it (a static QR).
  FiatAmount? get amount;

  /// Who gets paid, for the confirm screen.
  String get payeeName;

  /// The payee's ID and references, e.g. "chai@okicici · Ref T123".
  String get payeeDetail;

  /// A merchant (biller, or a UPI merchant QR), as opposed to a person.
  bool get isMerchant;
}
