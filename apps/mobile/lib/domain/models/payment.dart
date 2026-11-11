/// Payment lifecycle. Mirrors the backend's `PaymentStatus`.
///
///   submitted -> paid -> payoutPending -> settled
///       |                      |
///       +-> failed             +-> refunded
enum PaymentStatus {
  submitted('SUBMITTED'),
  paid('PAID'),
  payoutPending('PAYOUT_PENDING'),
  settled('SETTLED'),
  refunded('REFUNDED'),
  failed('FAILED');

  const PaymentStatus(this.apiValue);

  /// The name used by the backend API.
  final String apiValue;

  bool get isTerminal => this == settled || this == refunded || this == failed;

  static PaymentStatus fromApi(String value) => PaymentStatus.values.firstWhere(
        (status) => status.apiValue == value,
        orElse: () => throw ArgumentError.value(value, 'value', 'Unknown payment status'),
      );
}

class Payment {
  const Payment({
    required this.id,
    required this.quoteId,
    required this.status,
    required this.createdAt,
    this.payTxHash,
    this.settleTxHash,
    this.refundTxHash,
  });

  final String id;
  final String quoteId;
  final PaymentStatus status;
  final DateTime createdAt;
  final String? payTxHash;
  final String? settleTxHash;
  final String? refundTxHash;
}
