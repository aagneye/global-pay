// coverage:ignore-file
// GENERATED CODE - DO NOT MODIFY BY HAND
// ignore_for_file: type=lint, unused_import, invalid_annotation_target, unnecessary_import

import 'package:json_annotation/json_annotation.dart';

part 'kyc_session.g.dart';

/// For the provider's mobile SDK. Null if the user is already approved.
@JsonSerializable()
class KycSession {
  const KycSession({
    required this.provider,
    required this.sessionToken,
    required this.expiresAt,
  });
  
  factory KycSession.fromJson(Map<String, Object?> json) => _$KycSessionFromJson(json);
  
  final String provider;
  final String sessionToken;
  final DateTime expiresAt;

  Map<String, Object?> toJson() => _$KycSessionToJson(this);
}
