// GENERATED CODE - DO NOT MODIFY BY HAND

part of 'nonce_response.dart';

// **************************************************************************
// JsonSerializableGenerator
// **************************************************************************

NonceResponse _$NonceResponseFromJson(Map<String, dynamic> json) =>
    NonceResponse(
      nonce: json['nonce'] as String,
      message: json['message'] as String,
      expiresAt: DateTime.parse(json['expiresAt'] as String),
    );

Map<String, dynamic> _$NonceResponseToJson(NonceResponse instance) =>
    <String, dynamic>{
      'nonce': instance.nonce,
      'message': instance.message,
      'expiresAt': instance.expiresAt.toIso8601String(),
    };
