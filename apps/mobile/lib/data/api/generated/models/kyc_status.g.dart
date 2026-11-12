// GENERATED CODE - DO NOT MODIFY BY HAND

part of 'kyc_status.dart';

// **************************************************************************
// JsonSerializableGenerator
// **************************************************************************

KycStatus _$KycStatusFromJson(Map<String, dynamic> json) => KycStatus(
  status: KycStatusStatus.fromJson(json['status'] as String),
  tier: (json['tier'] as num).toInt(),
  limits: SpendingLimits.fromJson(json['limits'] as Map<String, dynamic>),
);

Map<String, dynamic> _$KycStatusToJson(KycStatus instance) => <String, dynamic>{
  'status': instance.status,
  'tier': instance.tier,
  'limits': instance.limits,
};
