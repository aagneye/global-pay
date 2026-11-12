// GENERATED CODE - DO NOT MODIFY BY HAND

part of 'kyc_session.dart';

// **************************************************************************
// JsonSerializableGenerator
// **************************************************************************

KycSession _$KycSessionFromJson(Map<String, dynamic> json) => KycSession(
  provider: json['provider'] as String,
  sessionToken: json['sessionToken'] as String,
  expiresAt: DateTime.parse(json['expiresAt'] as String),
);

Map<String, dynamic> _$KycSessionToJson(KycSession instance) =>
    <String, dynamic>{
      'provider': instance.provider,
      'sessionToken': instance.sessionToken,
      'expiresAt': instance.expiresAt.toIso8601String(),
    };
