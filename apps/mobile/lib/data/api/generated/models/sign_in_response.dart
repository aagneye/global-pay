// coverage:ignore-file
// GENERATED CODE - DO NOT MODIFY BY HAND
// ignore_for_file: type=lint, unused_import, invalid_annotation_target, unnecessary_import

import 'package:json_annotation/json_annotation.dart';

import 'sign_in_response_token_type.dart';
import 'user.dart';

part 'sign_in_response.g.dart';

@JsonSerializable()
class SignInResponse {
  const SignInResponse({
    required this.token,
    required this.tokenType,
    required this.expiresAt,
    required this.user,
  });
  
  factory SignInResponse.fromJson(Map<String, Object?> json) => _$SignInResponseFromJson(json);
  
  final String token;
  final SignInResponseTokenType tokenType;
  final DateTime expiresAt;
  final User user;

  Map<String, Object?> toJson() => _$SignInResponseToJson(this);
}
