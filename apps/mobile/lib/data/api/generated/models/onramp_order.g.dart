// GENERATED CODE - DO NOT MODIFY BY HAND

part of 'onramp_order.dart';

// **************************************************************************
// JsonSerializableGenerator
// **************************************************************************

OnrampOrder _$OnrampOrderFromJson(Map<String, dynamic> json) => OnrampOrder(
  id: json['id'] as String,
  status: OnrampOrderStatus.fromJson(json['status'] as String),
  provider: json['provider'] as String,
  fiatCurrency: json['fiatCurrency'] as String,
  fiatAmount: json['fiatAmount'] as String,
  expiresAt: DateTime.parse(json['expiresAt'] as String),
  createdAt: DateTime.parse(json['createdAt'] as String),
  updatedAt: DateTime.parse(json['updatedAt'] as String),
  tokenAmount: json['tokenAmount'] as String?,
  transaction: json['transaction'] == null
      ? null
      : OnrampTransaction.fromJson(json['transaction'] as Map<String, dynamic>),
  failureReason: json['failureReason'] as String?,
);

Map<String, dynamic> _$OnrampOrderToJson(OnrampOrder instance) =>
    <String, dynamic>{
      'id': instance.id,
      'status': instance.status,
      'provider': instance.provider,
      'fiatCurrency': instance.fiatCurrency,
      'fiatAmount': instance.fiatAmount,
      'tokenAmount': ?instance.tokenAmount,
      'transaction': ?instance.transaction,
      'failureReason': ?instance.failureReason,
      'expiresAt': instance.expiresAt.toIso8601String(),
      'createdAt': instance.createdAt.toIso8601String(),
      'updatedAt': instance.updatedAt.toIso8601String(),
    };
