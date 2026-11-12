// coverage:ignore-file
// GENERATED CODE - DO NOT MODIFY BY HAND
// ignore_for_file: type=lint, unused_import, invalid_annotation_target, unnecessary_import

import 'package:json_annotation/json_annotation.dart';

part 'payment_merchant.g.dart';

@JsonSerializable()
class PaymentMerchant {
  const PaymentMerchant({
    required this.kind,
    required this.targetId,
    this.name,
  });
  
  factory PaymentMerchant.fromJson(Map<String, Object?> json) => _$PaymentMerchantFromJson(json);
  
  final String kind;
  final String targetId;
  final String? name;

  Map<String, Object?> toJson() => _$PaymentMerchantToJson(this);
}
