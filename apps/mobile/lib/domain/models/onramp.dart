import 'package:globalpay/domain/models/money.dart';
import 'package:globalpay/domain/models/payment.dart';

/// An "Add money" order's lifecycle. Mirrors the backend's `OnrampOrder.status`.
///
///   created -> pending -> completed   (USDC arrived in the wallet, checked on-chain)
///      |          |
///      |          +----> failed
///      +-> expired (not paid in time)
enum OnrampStatus {
  created('CREATED', 'Waiting for payment'),
  pending('PENDING', 'On its way'),
  completed('COMPLETED', 'Added'),
  failed('FAILED', 'Failed'),
  expired('EXPIRED', 'Expired');

  const OnrampStatus(this.apiValue, this.label);

  final String apiValue;
  final String label;

  /// Expired orders can still come back if the payment turns up, but the app stops waiting.
  bool get isTerminal => this == completed || this == failed || this == expired;

  /// An unknown status from a newer backend reads as pending: keep waiting, never "added".
  static OnrampStatus fromApi(String? value) =>
      OnrampStatus.values.firstWhere((s) => s.apiValue == value, orElse: () => OnrampStatus.pending);
}

class OnrampOrder {
  const OnrampOrder({
    required this.id,
    required this.status,
    required this.fiatAmount,
    required this.createdAt,
    this.tokenAmount,
    this.transaction,
    this.failureReason,
  });

  final String id;
  final OnrampStatus status;
  final FiatAmount fiatAmount;

  /// Received once completed, else what the partner said it will send.
  final TokenAmount? tokenAmount;
  final TxLink? transaction;
  final String? failureReason;
  final DateTime createdAt;
}

/// USDC that arrived in the wallet from outside: another wallet, an exchange, or Add money.
class Deposit {
  const Deposit({
    required this.id,
    required this.amount,
    required this.from,
    required this.transaction,
    required this.createdAt,
    this.onrampOrderId,
  });

  final String id;
  final TokenAmount amount;
  final String from;
  final TxLink transaction;
  final DateTime createdAt;

  /// Set when it completed an Add-money order.
  final String? onrampOrderId;
}
