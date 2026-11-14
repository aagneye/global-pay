// GENERATED CODE - DO NOT MODIFY BY HAND

part of 'deposit_list.dart';

// **************************************************************************
// JsonSerializableGenerator
// **************************************************************************

DepositList _$DepositListFromJson(Map<String, dynamic> json) => DepositList(
  deposits: (json['deposits'] as List<dynamic>)
      .map((e) => Deposit.fromJson(e as Map<String, dynamic>))
      .toList(),
);

Map<String, dynamic> _$DepositListToJson(DepositList instance) =>
    <String, dynamic>{'deposits': instance.deposits};
