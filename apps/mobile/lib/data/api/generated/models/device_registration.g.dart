// GENERATED CODE - DO NOT MODIFY BY HAND

part of 'device_registration.dart';

// **************************************************************************
// JsonSerializableGenerator
// **************************************************************************

DeviceRegistration _$DeviceRegistrationFromJson(Map<String, dynamic> json) =>
    DeviceRegistration(
      publicKey: json['publicKey'] as String,
      platform: DeviceRegistrationPlatform.fromJson(json['platform'] as String),
      fcmToken: json['fcmToken'] as String?,
    );

Map<String, dynamic> _$DeviceRegistrationToJson(DeviceRegistration instance) =>
    <String, dynamic>{
      'publicKey': instance.publicKey,
      'platform': instance.platform,
      'fcmToken': ?instance.fcmToken,
    };
