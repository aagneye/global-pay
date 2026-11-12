// coverage:ignore-file
// GENERATED CODE - DO NOT MODIFY BY HAND
// ignore_for_file: type=lint, unused_import, invalid_annotation_target, unnecessary_import

import 'package:json_annotation/json_annotation.dart';

import 'kyc_status_status.dart';
import 'spending_limits.dart';

part 'kyc_status.g.dart';

@JsonSerializable()
class KycStatus {
  const KycStatus({
    required this.status,
    required this.tier,
    required this.limits,
  });
  
  factory KycStatus.fromJson(Map<String, Object?> json) => _$KycStatusFromJson(json);
  
  final KycStatusStatus status;

  /// 0 until verification is approved
  final int tier;
  final SpendingLimits limits;

  Map<String, Object?> toJson() => _$KycStatusToJson(this);
}
