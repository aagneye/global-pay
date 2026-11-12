// coverage:ignore-file
// GENERATED CODE - DO NOT MODIFY BY HAND
// ignore_for_file: type=lint, unused_import, invalid_annotation_target, unnecessary_import

import 'package:json_annotation/json_annotation.dart';

part 'sign_in_request.g.dart';

@JsonSerializable()
class SignInRequest {
  const SignInRequest({
    required this.message,
    required this.signature,
  });
  
  factory SignInRequest.fromJson(Map<String, Object?> json) => _$SignInRequestFromJson(json);
  
  final String message;

  /// personal_sign signature over `message`
  final String signature;

  Map<String, Object?> toJson() => _$SignInRequestToJson(this);
}
