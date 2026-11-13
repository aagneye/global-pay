// GENERATED CODE - DO NOT MODIFY BY HAND

part of 'payment_payout.dart';

// **************************************************************************
// JsonSerializableGenerator
// **************************************************************************

PaymentPayout _$PaymentPayoutFromJson(Map<String, dynamic> json) =>
    PaymentPayout(
      status: PaymentPayoutStatus.fromJson(json['status'] as String),
      provider: json['provider'] as String,
      reference: json['reference'] as String?,
    );

Map<String, dynamic> _$PaymentPayoutToJson(PaymentPayout instance) =>
    <String, dynamic>{
      'status': instance.status,
      'provider': instance.provider,
      'reference': ?instance.reference,
    };
