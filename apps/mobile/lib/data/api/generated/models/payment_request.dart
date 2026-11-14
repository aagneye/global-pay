// coverage:ignore-file
// GENERATED CODE - DO NOT MODIFY BY HAND
// ignore_for_file: type=lint, unused_import, invalid_annotation_target, unnecessary_import

import 'package:json_annotation/json_annotation.dart';

part 'payment_request.g.dart';

@JsonSerializable()
class PaymentRequest {
  const PaymentRequest({
    required this.quoteId,
    this.validAfter,
    this.validBefore,
    this.signature,
    this.signedDelegate,
  });
  
  factory PaymentRequest.fromJson(Map<String, Object?> json) => _$PaymentRequestFromJson(json);
  
  final String quoteId;

  /// EVM rail (required there): from authorizationToSign.message, unchanged
  final String? validAfter;

  /// EVM rail (required there): from authorizationToSign.message, unchanged
  final String? validBefore;

  /// EVM rail (required there): the payer wallet's signature over authorizationToSign
  final String? signature;

  /// NEAR rail (required there): base64 of the borsh SignedDelegate (NEP-366) for nearPayment
  final String? signedDelegate;

  Map<String, Object?> toJson() => _$PaymentRequestToJson(this);
}
