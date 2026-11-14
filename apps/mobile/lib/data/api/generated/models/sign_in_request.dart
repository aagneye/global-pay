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
    this.publicKey,
  });
  
  factory SignInRequest.fromJson(Map<String, Object?> json) => _$SignInRequestFromJson(json);
  
  final String message;

  /// EVM rail: personal_sign signature over `message` (0x hex). NEAR rail: the NEP-413 ed25519 signature (base64, 64 bytes)
  final String signature;

  /// NEAR rail (required there): the key that signed, "ed25519:" + base58
  final String? publicKey;

  Map<String, Object?> toJson() => _$SignInRequestToJson(this);
}
