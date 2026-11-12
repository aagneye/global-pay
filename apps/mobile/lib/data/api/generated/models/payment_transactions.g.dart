// GENERATED CODE - DO NOT MODIFY BY HAND

part of 'payment_transactions.dart';

// **************************************************************************
// JsonSerializableGenerator
// **************************************************************************

PaymentTransactions _$PaymentTransactionsFromJson(Map<String, dynamic> json) =>
    PaymentTransactions(
      pay: json['pay'] == null
          ? null
          : TxLink.fromJson(json['pay'] as Map<String, dynamic>),
      settle: json['settle'] == null
          ? null
          : TxLink.fromJson(json['settle'] as Map<String, dynamic>),
      refund: json['refund'] == null
          ? null
          : TxLink.fromJson(json['refund'] as Map<String, dynamic>),
    );

Map<String, dynamic> _$PaymentTransactionsToJson(
  PaymentTransactions instance,
) => <String, dynamic>{
  'pay': ?instance.pay,
  'settle': ?instance.settle,
  'refund': ?instance.refund,
};
