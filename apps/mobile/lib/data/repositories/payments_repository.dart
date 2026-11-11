import 'package:globalpay/data/api/api_client.dart';
import 'package:globalpay/domain/models/payment.dart';
import 'package:globalpay/domain/models/quote.dart';

/// Quote -> sign -> submit -> poll status (POST /quotes, POST /payments, GET /payments/:id).
class PaymentsRepository {
  const PaymentsRepository({required this.api});

  final ApiClient api;

  static const _planned = 'Payments API is planned for iteration 5';

  /// [fiatAmountMinor] is required when the QR is static (has no amount).
  Future<(Quote, AuthorizationToSign)> requestQuote({
    required String qrPayload,
    BigInt? fiatAmountMinor,
  }) =>
      throw UnimplementedError(_planned);

  Future<Payment> submit({
    required String quoteId,
    required BigInt validAfter,
    required BigInt validBefore,
    required String signature,
  }) =>
      throw UnimplementedError(_planned);

  Future<Payment> get(String paymentId) => throw UnimplementedError(_planned);
}
