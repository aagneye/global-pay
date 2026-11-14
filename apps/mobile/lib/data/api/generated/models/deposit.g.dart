// GENERATED CODE - DO NOT MODIFY BY HAND

part of 'deposit.dart';

// **************************************************************************
// JsonSerializableGenerator
// **************************************************************************

Deposit _$DepositFromJson(Map<String, dynamic> json) => Deposit(
  id: json['id'] as String,
  token: json['token'] as String,
  amount: json['amount'] as String,
  from: json['from'] as String,
  transaction: DepositTransaction.fromJson(
    json['transaction'] as Map<String, dynamic>,
  ),
  createdAt: DateTime.parse(json['createdAt'] as String),
  onrampOrderId: json['onrampOrderId'] as String?,
);

Map<String, dynamic> _$DepositToJson(Deposit instance) => <String, dynamic>{
  'id': instance.id,
  'token': instance.token,
  'amount': instance.amount,
  'from': instance.from,
  'transaction': instance.transaction,
  'onrampOrderId': ?instance.onrampOrderId,
  'createdAt': instance.createdAt.toIso8601String(),
};
