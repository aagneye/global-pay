// GENERATED CODE - DO NOT MODIFY BY HAND

part of 'balance.dart';

// **************************************************************************
// JsonSerializableGenerator
// **************************************************************************

Balance _$BalanceFromJson(Map<String, dynamic> json) => Balance(
  token: json['token'] as String,
  units: json['units'] as String,
  decimals: (json['decimals'] as num).toInt(),
);

Map<String, dynamic> _$BalanceToJson(Balance instance) => <String, dynamic>{
  'token': instance.token,
  'units': instance.units,
  'decimals': instance.decimals,
};
