// coverage:ignore-file
// GENERATED CODE - DO NOT MODIFY BY HAND
// ignore_for_file: type=lint, unused_import, invalid_annotation_target, unnecessary_import

import 'package:json_annotation/json_annotation.dart';

part 'spending_limits.g.dart';

@JsonSerializable()
class SpendingLimits {
  const SpendingLimits({
    required this.perPayment,
    required this.perDay,
  });
  
  factory SpendingLimits.fromJson(Map<String, Object?> json) => _$SpendingLimitsFromJson(json);
  
  /// THB satang
  final String perPayment;

  /// THB satang, rolling 24 hours
  final String perDay;

  Map<String, Object?> toJson() => _$SpendingLimitsToJson(this);
}
