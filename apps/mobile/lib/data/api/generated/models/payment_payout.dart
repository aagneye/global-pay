// coverage:ignore-file
// GENERATED CODE - DO NOT MODIFY BY HAND
// ignore_for_file: type=lint, unused_import, invalid_annotation_target, unnecessary_import

import 'package:json_annotation/json_annotation.dart';

import 'payment_payout_status.dart';

part 'payment_payout.g.dart';

/// Paying the merchant in fiatCurrency (THB, INR). Absent until the payment is paid on-chain.
@JsonSerializable()
class PaymentPayout {
  const PaymentPayout({
    required this.status,
    required this.provider,
    this.reference,
  });
  
  factory PaymentPayout.fromJson(Map<String, Object?> json) => _$PaymentPayoutFromJson(json);
  
  /// PENDING: being paid. SUCCEEDED: the merchant was paid (see reference). FAILED: not paid; the user is refunded. UNKNOWN: unclear, being checked; never settled or refunded until it is clear. REVERSED: paid, then undone.
  final PaymentPayoutStatus status;
  final String provider;

  /// Bank or partner reference, once paid
  final String? reference;

  Map<String, Object?> toJson() => _$PaymentPayoutToJson(this);
}
