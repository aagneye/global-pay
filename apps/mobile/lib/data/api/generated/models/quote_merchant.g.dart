// GENERATED CODE - DO NOT MODIFY BY HAND

part of 'quote_merchant.dart';

// **************************************************************************
// JsonSerializableGenerator
// **************************************************************************

QuoteMerchant _$QuoteMerchantFromJson(Map<String, dynamic> json) =>
    QuoteMerchant(
      kind: QuoteMerchantKind.fromJson(json['kind'] as String),
      targetType: QuoteMerchantTargetType.fromJson(
        json['targetType'] as String,
      ),
      targetId: json['targetId'] as String,
      reference1: json['reference1'] as String?,
      reference2: json['reference2'] as String?,
      merchantName: json['merchantName'] as String?,
      merchantCity: json['merchantCity'] as String?,
    );

Map<String, dynamic> _$QuoteMerchantToJson(QuoteMerchant instance) =>
    <String, dynamic>{
      'kind': instance.kind,
      'targetType': instance.targetType,
      'targetId': instance.targetId,
      'reference1': ?instance.reference1,
      'reference2': ?instance.reference2,
      'merchantName': ?instance.merchantName,
      'merchantCity': ?instance.merchantCity,
    };
