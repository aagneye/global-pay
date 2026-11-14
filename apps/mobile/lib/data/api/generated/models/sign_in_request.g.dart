// GENERATED CODE - DO NOT MODIFY BY HAND

part of 'sign_in_request.dart';

// **************************************************************************
// JsonSerializableGenerator
// **************************************************************************

SignInRequest _$SignInRequestFromJson(Map<String, dynamic> json) =>
    SignInRequest(
      message: json['message'] as String,
      signature: json['signature'] as String,
      publicKey: json['publicKey'] as String?,
    );

Map<String, dynamic> _$SignInRequestToJson(SignInRequest instance) =>
    <String, dynamic>{
      'message': instance.message,
      'signature': instance.signature,
      'publicKey': ?instance.publicKey,
    };
