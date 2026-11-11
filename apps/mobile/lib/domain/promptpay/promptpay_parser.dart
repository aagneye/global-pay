import 'package:globalpay/domain/models/promptpay_qr.dart';

/// Error codes shared with packages/fixtures/promptpay/vectors.json.
enum PromptPayError { missingCrc, crcMismatch, malformedTlv, notPromptPay, unsupportedCurrency }

class PromptPayParseException implements Exception {
  const PromptPayParseException(this.error, this.message);

  final PromptPayError error;
  final String message;

  @override
  String toString() => 'PromptPayParseException(${error.name}): $message';
}

/// Parses and validates an EMVCo PromptPay payload.
///
/// Checks run in the order documented in packages/fixtures/README.md:
/// CRC present and valid -> TLV well formed -> PromptPay tag 29/30 -> currency THB (764).
/// The backend re-validates every QR, so this is for instant feedback in the app.
PromptPayQr parsePromptPayQr(String payload) =>
    throw UnimplementedError('PromptPay parser is planned for iteration 5');
