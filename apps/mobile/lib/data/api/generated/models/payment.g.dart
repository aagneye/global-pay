// GENERATED CODE - DO NOT MODIFY BY HAND

part of 'payment.dart';

// **************************************************************************
// JsonSerializableGenerator
// **************************************************************************

Payment _$PaymentFromJson(Map<String, dynamic> json) => Payment(
  id: json['id'] as String,
  quoteId: json['quoteId'] as String,
  status: PaymentStatus.fromJson(json['status'] as String),
  fiatCurrency: json['fiatCurrency'] as String,
  fiatAmount: json['fiatAmount'] as String,
  token: json['token'] as String,
  tokenAmount: json['tokenAmount'] as String,
  merchant: PaymentMerchant.fromJson(json['merchant'] as Map<String, dynamic>),
  transactions: PaymentTransactions.fromJson(
    json['transactions'] as Map<String, dynamic>,
  ),
  quoteExpiresAt: DateTime.parse(json['quoteExpiresAt'] as String),
  createdAt: DateTime.parse(json['createdAt'] as String),
  updatedAt: DateTime.parse(json['updatedAt'] as String),
  payout: json['payout'] == null
      ? null
      : PaymentPayout.fromJson(json['payout'] as Map<String, dynamic>),
  failureReason: json['failureReason'] as String?,
);

Map<String, dynamic> _$PaymentToJson(Payment instance) => <String, dynamic>{
  'id': instance.id,
  'quoteId': instance.quoteId,
  'status': instance.status,
  'fiatCurrency': instance.fiatCurrency,
  'fiatAmount': instance.fiatAmount,
  'token': instance.token,
  'tokenAmount': instance.tokenAmount,
  'merchant': instance.merchant,
  'transactions': instance.transactions,
  'payout': ?instance.payout,
  'failureReason': ?instance.failureReason,
  'quoteExpiresAt': instance.quoteExpiresAt.toIso8601String(),
  'createdAt': instance.createdAt.toIso8601String(),
  'updatedAt': instance.updatedAt.toIso8601String(),
};
