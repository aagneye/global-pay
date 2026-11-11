import 'package:globalpay/domain/models/money.dart';

/// `merchant`: bill payment (tag 30). `personal`: credit transfer (tag 29).
enum PromptPayKind { personal, merchant }

/// How the PromptPay payee is identified.
enum PromptPayTargetType { mobile, nationalId, eWallet, biller }

/// A parsed Thai PromptPay QR (EMVCo). Field meanings match packages/fixtures/promptpay.
class PromptPayQr {
  const PromptPayQr({
    required this.raw,
    required this.isDynamic,
    required this.kind,
    required this.targetType,
    required this.targetId,
    this.reference1,
    this.reference2,
    this.amount,
    this.merchantName,
    this.merchantCity,
  });

  /// The original payload, sent to the backend for quoting.
  final String raw;

  /// Dynamic QRs carry an amount and are single use; static QRs need the user to enter one.
  final bool isDynamic;
  final PromptPayKind kind;
  final PromptPayTargetType targetType;
  final String targetId;
  final String? reference1;
  final String? reference2;
  final FiatAmount? amount;
  final String? merchantName;
  final String? merchantCity;
}
