// coverage:ignore-file
// GENERATED CODE - DO NOT MODIFY BY HAND
// ignore_for_file: type=lint, unused_import, invalid_annotation_target, unnecessary_import

import 'package:json_annotation/json_annotation.dart';

import 'kyc_session.dart';
import 'kyc_start_status.dart';
import 'spending_limits.dart';

part 'kyc_start.g.dart';

@JsonSerializable()
class KycStart {
  const KycStart({
    required this.status,
    required this.tier,
    required this.limits,
    required this.session,
  });
  
  factory KycStart.fromJson(Map<String, Object?> json) => _$KycStartFromJson(json);
  
  final KycStartStatus status;

  /// 0 until verification is approved
  final int tier;
  final SpendingLimits limits;
  final KycSession? session;

  Map<String, Object?> toJson() => _$KycStartToJson(this);
}
