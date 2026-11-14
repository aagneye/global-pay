// GENERATED CODE - DO NOT MODIFY BY HAND

part of 'deposit_transaction.dart';

// **************************************************************************
// JsonSerializableGenerator
// **************************************************************************

DepositTransaction _$DepositTransactionFromJson(Map<String, dynamic> json) =>
    DepositTransaction(
      hash: json['hash'] as String,
      url: json['url'] as String,
    );

Map<String, dynamic> _$DepositTransactionToJson(DepositTransaction instance) =>
    <String, dynamic>{'hash': instance.hash, 'url': instance.url};
