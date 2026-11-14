import 'package:globalpay/domain/models/money.dart';
import 'package:globalpay/domain/models/payment.dart';

/// A tap-to-pay request's lifecycle. Mirrors the backend's `P2pRequest.status` (ADR 0010).
enum P2pStatus {
  created('CREATED'),
  senderIdentified('SENDER_IDENTIFIED'),
  submitted('SUBMITTED'),
  completed('COMPLETED'),
  failed('FAILED'),
  expired('EXPIRED'),
  declined('DECLINED'),
  cancelled('CANCELLED');

  const P2pStatus(this.apiValue);

  final String apiValue;

  bool get isFinal => switch (this) {
    created || senderIdentified || submitted => false,
    _ => true,
  };

  /// A status from a newer backend reads as still in progress: never "paid".
  static P2pStatus fromApi(String? value) =>
      P2pStatus.values.firstWhere((s) => s.apiValue == value, orElse: () => P2pStatus.submitted);
}

class P2pRequest {
  const P2pRequest({
    required this.id,
    required this.isReceiver,
    required this.status,
    required this.amount,
    required this.recipientName,
    required this.recipientVerified,
    required this.recipientAddress,
    required this.expiresAt,
    this.senderAddress,
    this.challenge,
    this.transaction,
    this.failureReason,
  });

  final String id;

  /// True on the receiver's phone, false on the sender's.
  final bool isReceiver;
  final P2pStatus status;
  final TokenAmount amount;

  /// From the receiver's profile, copied by the backend: the sender can trust it came from there.
  final String recipientName;

  /// The name comes from identity verification, not from the receiver.
  final bool recipientVerified;
  final String recipientAddress;
  final DateTime expiresAt;
  final String? senderAddress;

  /// Receiver only, while waiting for a sender: what the other phone signs, and what the QR carries.
  final String? challenge;
  final TxLink? transaction;
  final String? failureReason;
}
