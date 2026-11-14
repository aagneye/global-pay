// coverage:ignore-file
// GENERATED CODE - DO NOT MODIFY BY HAND
// ignore_for_file: type=lint, unused_import, invalid_annotation_target, unnecessary_import

import 'package:json_annotation/json_annotation.dart';

import 'device_registration_platform.dart';

part 'device_registration.g.dart';

@JsonSerializable()
class DeviceRegistration {
  const DeviceRegistration({
    required this.publicKey,
    required this.platform,
    this.fcmToken,
  });
  
  factory DeviceRegistration.fromJson(Map<String, Object?> json) => _$DeviceRegistrationFromJson(json);
  
  /// P-256 public key, SPKI DER, base64
  final String publicKey;
  final DeviceRegistrationPlatform platform;
  final String? fcmToken;

  Map<String, Object?> toJson() => _$DeviceRegistrationToJson(this);
}
