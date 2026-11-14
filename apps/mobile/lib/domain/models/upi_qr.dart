import 'package:globalpay/domain/models/money.dart';
import 'package:globalpay/domain/models/payment_qr.dart';

/// A parsed Indian UPI QR: `upi://pay?pa=<vpa>&pn=<name>&am=<amount>&cu=INR&mc=<code>&tr=<ref>`.
class UpiQr implements PaymentQr {
  const UpiQr({
    required this.raw,
    required this.vpa,
    this.name,
    this.amount,
    this.merchantCode,
    this.reference,
    this.note,
  });

  @override
  final String raw;

  /// The payee's UPI ID (`pa`), e.g. `chaipoint@okicici`.
  final String vpa;

  /// The payee's name (`pn`), URL-decoded.
  final String? name;

  /// Fixed by the QR (`am`), in rupees.
  @override
  final FiatAmount? amount;

  /// The merchant category code (`mc`): present on merchant QRs.
  final String? merchantCode;

  /// The transaction reference (`tr`).
  final String? reference;

  /// The note (`tn`).
  final String? note;

  @override
  FiatCurrency get currency => FiatCurrency.inr;

  @override
  String get payeeName => name ?? vpa;

  @override
  String get payeeDetail => [vpa, if (reference != null) 'Ref $reference'].join(' · ');

  @override
  bool get isMerchant => merchantCode != null;
}
