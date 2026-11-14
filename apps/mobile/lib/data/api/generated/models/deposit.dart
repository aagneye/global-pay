// coverage:ignore-file
// GENERATED CODE - DO NOT MODIFY BY HAND
// ignore_for_file: type=lint, unused_import, invalid_annotation_target, unnecessary_import

import 'package:json_annotation/json_annotation.dart';

import 'deposit_transaction.dart';

part 'deposit.g.dart';

@JsonSerializable()
class Deposit {
  const Deposit({
    required this.id,
    required this.token,
    required this.amount,
    required this.from,
    required this.transaction,
    required this.createdAt,
    this.onrampOrderId,
  });
  
  factory Deposit.fromJson(Map<String, Object?> json) => _$DepositFromJson(json);
  
  final String id;
  final String token;

  /// Token base units
  final String amount;
  final String from;
  final DepositTransaction transaction;

  /// The Add-money order this completed
  final String? onrampOrderId;
  final DateTime createdAt;

  Map<String, Object?> toJson() => _$DepositToJson(this);
}
