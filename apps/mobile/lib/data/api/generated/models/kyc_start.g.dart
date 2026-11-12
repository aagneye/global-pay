// GENERATED CODE - DO NOT MODIFY BY HAND

part of 'kyc_start.dart';

// **************************************************************************
// JsonSerializableGenerator
// **************************************************************************

KycStart _$KycStartFromJson(Map<String, dynamic> json) => KycStart(
  status: KycStartStatus.fromJson(json['status'] as String),
  tier: (json['tier'] as num).toInt(),
  limits: SpendingLimits.fromJson(json['limits'] as Map<String, dynamic>),
  session: json['session'] == null
      ? null
      : KycSession.fromJson(json['session'] as Map<String, dynamic>),
);

Map<String, dynamic> _$KycStartToJson(KycStart instance) => <String, dynamic>{
  'status': instance.status,
  'tier': instance.tier,
  'limits': instance.limits,
  'session': ?instance.session,
};
