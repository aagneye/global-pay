// coverage:ignore-file
// GENERATED CODE - DO NOT MODIFY BY HAND
// ignore_for_file: type=lint, unused_import, invalid_annotation_target, unnecessary_import

import 'package:json_annotation/json_annotation.dart';

part 'nonce_response.g.dart';

@JsonSerializable()
class NonceResponse {
  const NonceResponse({
    required this.nonce,
    required this.message,
    required this.expiresAt,
  });
  
  factory NonceResponse.fromJson(Map<String, Object?> json) => _$NonceResponseFromJson(json);
  
  /// EVM rail: the SIWE nonce. NEAR rail: the NEP-413 nonce, 32 bytes as hex
  final String nonce;

  /// EVM rail: EIP-4361 message to sign with personal_sign, unchanged. NEAR rail: the NEP-413 `message` to sign, unchanged, with this nonce and recipient = the sign-in domain
  final String message;
  final DateTime expiresAt;

  Map<String, Object?> toJson() => _$NonceResponseToJson(this);
}
