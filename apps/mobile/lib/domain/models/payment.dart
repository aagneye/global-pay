import 'package:globalpay/domain/models/money.dart';

/// Payment lifecycle. Mirrors the backend's `PaymentStatus`.
///
///   submitted -> paid -> payoutPending -> settled
///       |                      |
///       +-> failed             +-> refunded
enum PaymentStatus {
  submitted('SUBMITTED', 'Sending'),
  paid('PAID', 'Received'),
  payoutPending('PAYOUT_PENDING', 'Paying merchant'),
  settled('SETTLED', 'Paid'),
  refunded('REFUNDED', 'Refunded'),
  failed('FAILED', 'Failed');

  const PaymentStatus(this.apiValue, this.label);

  /// The name used by the backend API.
  final String apiValue;

  /// Short label for the UI.
  final String label;

  bool get isTerminal => this == settled || this == refunded || this == failed;

  static PaymentStatus fromApi(String value) => PaymentStatus.values.firstWhere(
    (status) => status.apiValue == value,
    orElse: () => throw ArgumentError.value(value, 'value', 'Unknown payment status'),
  );
}

/// An on-chain transaction, with its block explorer link.
class TxLink {
  const TxLink({required this.hash, required this.url});

  final String hash;
  final String url;
}

class Payment {
  const Payment({
    required this.id,
    required this.quoteId,
    required this.status,
    required this.fiatAmount,
    required this.tokenAmount,
    required this.merchantName,
    required this.createdAt,
    this.failureReason,
    this.payTx,
    this.settleTx,
    this.refundTx,
  });

  final String id;
  final String quoteId;
  final PaymentStatus status;
  final FiatAmount fiatAmount;
  final TokenAmount tokenAmount;
  final String merchantName;
  final DateTime createdAt;

  /// Why it failed, or why the merchant payout failed and the USDC was refunded.
  final String? failureReason;
  final TxLink? payTx;
  final TxLink? settleTx;
  final TxLink? refundTx;
}
