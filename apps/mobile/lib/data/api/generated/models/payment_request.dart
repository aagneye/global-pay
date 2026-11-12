// coverage:ignore-file
// GENERATED CODE - DO NOT MODIFY BY HAND
// ignore_for_file: type=lint, unused_import, invalid_annotation_target, unnecessary_import

import 'package:json_annotation/json_annotation.dart';

part 'payment_request.g.dart';

@JsonSerializable()
class PaymentRequest {
  const PaymentRequest({
    required this.quoteId,
    required this.validAfter,
    required this.validBefore,
    required this.signature,
  });
  
  factory PaymentRequest.fromJson(Map<String, Object?> json) => _$PaymentRequestFromJson(json);
  
  final String quoteId;

  /// From authorizationToSign.message, unchanged
  final String validAfter;

  /// From authorizationToSign.message, unchanged
  final String validBefore;

  /// The payer wallet's signature over authorizationToSign
  final String signature;

  Map<String, Object?> toJson() => _$PaymentRequestToJson(this);
}
