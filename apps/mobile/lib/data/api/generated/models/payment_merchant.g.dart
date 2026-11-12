// GENERATED CODE - DO NOT MODIFY BY HAND

part of 'payment_merchant.dart';

// **************************************************************************
// JsonSerializableGenerator
// **************************************************************************

PaymentMerchant _$PaymentMerchantFromJson(Map<String, dynamic> json) =>
    PaymentMerchant(
      kind: json['kind'] as String,
      targetId: json['targetId'] as String,
      name: json['name'] as String?,
    );

Map<String, dynamic> _$PaymentMerchantToJson(PaymentMerchant instance) =>
    <String, dynamic>{
      'kind': instance.kind,
      'targetId': instance.targetId,
      'name': ?instance.name,
    };
