// coverage:ignore-file
// GENERATED CODE - DO NOT MODIFY BY HAND
// ignore_for_file: type=lint, unused_import, invalid_annotation_target, unnecessary_import

import 'package:json_annotation/json_annotation.dart';

import 'payment_merchant.dart';
import 'payment_payout.dart';
import 'payment_status.dart';
import 'payment_transactions.dart';

part 'payment.g.dart';

@JsonSerializable()
class Payment {
  const Payment({
    required this.id,
    required this.quoteId,
    required this.status,
    required this.fiatCurrency,
    required this.fiatAmount,
    required this.token,
    required this.tokenAmount,
    required this.merchant,
    required this.transactions,
    required this.quoteExpiresAt,
    required this.createdAt,
    required this.updatedAt,
    this.payout,
    this.failureReason,
  });
  
  factory Payment.fromJson(Map<String, Object?> json) => _$PaymentFromJson(json);
  
  final String id;
  final String quoteId;

  /// SETTLED, REFUNDED and FAILED are final. Poll until one of them.
  final PaymentStatus status;
  final String fiatCurrency;

  /// Minor units of fiatCurrency (satang, paise) the merchant receives
  final String fiatAmount;

  /// USDC: its 0x address (EVM rail) or contract account ID (NEAR rail)
  final String token;

  /// USDC base units the user pays
  final String tokenAmount;
  final PaymentMerchant merchant;
  final PaymentTransactions transactions;
  final PaymentPayout? payout;
  final String? failureReason;
  final DateTime quoteExpiresAt;
  final DateTime createdAt;
  final DateTime updatedAt;

  Map<String, Object?> toJson() => _$PaymentToJson(this);
}
