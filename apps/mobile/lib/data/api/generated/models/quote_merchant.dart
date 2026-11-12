// coverage:ignore-file
// GENERATED CODE - DO NOT MODIFY BY HAND
// ignore_for_file: type=lint, unused_import, invalid_annotation_target, unnecessary_import

import 'package:json_annotation/json_annotation.dart';

import 'quote_merchant_kind.dart';
import 'quote_merchant_target_type.dart';

part 'quote_merchant.g.dart';

@JsonSerializable()
class QuoteMerchant {
  const QuoteMerchant({
    required this.kind,
    required this.targetType,
    required this.targetId,
    this.reference1,
    this.reference2,
    this.merchantName,
    this.merchantCity,
  });
  
  factory QuoteMerchant.fromJson(Map<String, Object?> json) => _$QuoteMerchantFromJson(json);
  
  final QuoteMerchantKind kind;
  final QuoteMerchantTargetType targetType;
  final String targetId;
  final String? reference1;
  final String? reference2;
  final String? merchantName;
  final String? merchantCity;

  Map<String, Object?> toJson() => _$QuoteMerchantToJson(this);
}
