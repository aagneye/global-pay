// coverage:ignore-file
// GENERATED CODE - DO NOT MODIFY BY HAND
// ignore_for_file: type=lint, unused_import, invalid_annotation_target, unnecessary_import

import 'package:json_annotation/json_annotation.dart';

import 'onramp_order_status.dart';
import 'onramp_transaction.dart';

part 'onramp_order.g.dart';

@JsonSerializable()
class OnrampOrder {
  const OnrampOrder({
    required this.id,
    required this.status,
    required this.provider,
    required this.fiatCurrency,
    required this.fiatAmount,
    required this.expiresAt,
    required this.createdAt,
    required this.updatedAt,
    this.tokenAmount,
    this.transaction,
    this.failureReason,
  });
  
  factory OnrampOrder.fromJson(Map<String, Object?> json) => _$OnrampOrderFromJson(json);
  
  final String id;

  /// CREATED: waiting for you to pay. PENDING: paid, USDC on its way. COMPLETED: USDC arrived in your wallet (checked on-chain). FAILED: the purchase failed. EXPIRED: not paid in time.
  final OnrampOrderStatus status;
  final String provider;
  final String fiatCurrency;

  /// THB satang you pay
  final String fiatAmount;

  /// USDC base units: received, or promised by the partner
  final String? tokenAmount;
  final OnrampTransaction? transaction;
  final String? failureReason;
  final DateTime expiresAt;
  final DateTime createdAt;
  final DateTime updatedAt;

  Map<String, Object?> toJson() => _$OnrampOrderToJson(this);
}
