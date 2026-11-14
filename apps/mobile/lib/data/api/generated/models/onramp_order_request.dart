// coverage:ignore-file
// GENERATED CODE - DO NOT MODIFY BY HAND
// ignore_for_file: type=lint, unused_import, invalid_annotation_target, unnecessary_import

import 'package:json_annotation/json_annotation.dart';

part 'onramp_order_request.g.dart';

@JsonSerializable()
class OnrampOrderRequest {
  const OnrampOrderRequest({
    required this.fiatAmountMinor,
  });
  
  factory OnrampOrderRequest.fromJson(Map<String, Object?> json) => _$OnrampOrderRequestFromJson(json);
  
  /// THB satang, e.g. "80000" = 800.00 THB
  final String fiatAmountMinor;

  Map<String, Object?> toJson() => _$OnrampOrderRequestToJson(this);
}
