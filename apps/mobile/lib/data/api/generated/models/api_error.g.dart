// GENERATED CODE - DO NOT MODIFY BY HAND

part of 'api_error.dart';

// **************************************************************************
// JsonSerializableGenerator
// **************************************************************************

ApiError _$ApiErrorFromJson(Map<String, dynamic> json) => ApiError(
  error: json['error'] as String,
  message: json['message'] as String?,
  issues: json['issues'] as List<dynamic>?,
);

Map<String, dynamic> _$ApiErrorToJson(ApiError instance) => <String, dynamic>{
  'error': instance.error,
  'message': ?instance.message,
  'issues': ?instance.issues,
};
