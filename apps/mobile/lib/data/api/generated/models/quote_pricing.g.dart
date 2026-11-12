// GENERATED CODE - DO NOT MODIFY BY HAND

part of 'quote_pricing.dart';

// **************************************************************************
// JsonSerializableGenerator
// **************************************************************************

QuotePricing _$QuotePricingFromJson(Map<String, dynamic> json) => QuotePricing(
  rateE8: json['rateE8'] as String,
  rateSource: json['rateSource'] as String,
  spreadBps: (json['spreadBps'] as num).toInt(),
  baseTokenAmount: json['baseTokenAmount'] as String,
  feeTokenAmount: json['feeTokenAmount'] as String,
);

Map<String, dynamic> _$QuotePricingToJson(QuotePricing instance) =>
    <String, dynamic>{
      'rateE8': instance.rateE8,
      'rateSource': instance.rateSource,
      'spreadBps': instance.spreadBps,
      'baseTokenAmount': instance.baseTokenAmount,
      'feeTokenAmount': instance.feeTokenAmount,
    };
