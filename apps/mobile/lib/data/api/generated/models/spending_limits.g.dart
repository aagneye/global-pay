// GENERATED CODE - DO NOT MODIFY BY HAND

part of 'spending_limits.dart';

// **************************************************************************
// JsonSerializableGenerator
// **************************************************************************

SpendingLimits _$SpendingLimitsFromJson(Map<String, dynamic> json) =>
    SpendingLimits(
      perPayment: json['perPayment'] as String,
      perDay: json['perDay'] as String,
    );

Map<String, dynamic> _$SpendingLimitsToJson(SpendingLimits instance) =>
    <String, dynamic>{
      'perPayment': instance.perPayment,
      'perDay': instance.perDay,
    };
