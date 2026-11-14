// coverage:ignore-file
// GENERATED CODE - DO NOT MODIFY BY HAND
// ignore_for_file: type=lint, unused_import, invalid_annotation_target, unnecessary_import

import 'package:json_annotation/json_annotation.dart';

part 'payment_request_create.g.dart';

@JsonSerializable()
class PaymentRequestCreate {
  const PaymentRequestCreate({
    required this.amount,
  });
  
  factory PaymentRequestCreate.fromJson(Map<String, Object?> json) => _$PaymentRequestCreateFromJson(json);
  
  /// USDC base units, e.g. "5000000" = 5 USDC
  final String amount;

  Map<String, Object?> toJson() => _$PaymentRequestCreateToJson(this);
}
