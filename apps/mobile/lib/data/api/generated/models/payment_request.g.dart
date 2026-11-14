// GENERATED CODE - DO NOT MODIFY BY HAND

part of 'payment_request.dart';

// **************************************************************************
// JsonSerializableGenerator
// **************************************************************************

PaymentRequest _$PaymentRequestFromJson(Map<String, dynamic> json) =>
    PaymentRequest(
      quoteId: json['quoteId'] as String,
      validAfter: json['validAfter'] as String?,
      validBefore: json['validBefore'] as String?,
      signature: json['signature'] as String?,
      signedDelegate: json['signedDelegate'] as String?,
    );

Map<String, dynamic> _$PaymentRequestToJson(PaymentRequest instance) =>
    <String, dynamic>{
      'quoteId': instance.quoteId,
      'validAfter': ?instance.validAfter,
      'validBefore': ?instance.validBefore,
      'signature': ?instance.signature,
      'signedDelegate': ?instance.signedDelegate,
    };
