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
  settled('SETTLED', 'Merchant paid'),
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

/// Paying the merchant in baht. Mirrors the backend's payout status.
enum PayoutStatus {
  pending,

  /// The merchant was paid; there's a bank or partner reference.
  succeeded,

  /// Definitely not paid: the USDC is refunded.
  failed,

  /// Unclear whether the merchant was paid. Never treated as paid or refunded until people check.
  unknown,

  /// Paid, then undone by the bank.
  reversed;

  /// A status this app doesn't know is treated as [unknown]: never shown as paid.
  static PayoutStatus fromApi(String? value) => switch (value) {
    'PENDING' => pending,
    'SUCCEEDED' => succeeded,
    'FAILED' => failed,
    'REVERSED' => reversed,
    _ => unknown,
  };
}

class Payout {
  const Payout({required this.status, required this.provider, this.reference});

  final PayoutStatus status;
  final String provider;

  /// Proof the merchant was paid, once [status] is [PayoutStatus.succeeded].
  final String? reference;
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
    this.payout,
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

  /// Absent until the USDC has arrived on-chain.
  final Payout? payout;

  /// Our partner can't yet say whether the merchant was paid, or the bank undid the payout:
  /// people are checking, so it's neither "paid" nor "refunded".
  bool get needsReview => payout?.status == PayoutStatus.unknown || payout?.status == PayoutStatus.reversed;

  /// Short label for lists.
  String get statusLabel => needsReview ? 'Needs review' : status.label;
}
