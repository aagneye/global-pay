// coverage:ignore-file
// GENERATED CODE - DO NOT MODIFY BY HAND
// ignore_for_file: type=lint, unused_import, invalid_annotation_target, unnecessary_import

import 'package:json_annotation/json_annotation.dart';

part 'quote_pricing.g.dart';

@JsonSerializable()
class QuotePricing {
  const QuotePricing({
    required this.rateE8,
    required this.rateSource,
    required this.spreadBps,
    required this.baseTokenAmount,
    required this.feeTokenAmount,
  });
  
  factory QuotePricing.fromJson(Map<String, Object?> json) => _$QuotePricingFromJson(json);
  
  /// Mid-market fiatCurrency per USDC × 1e8
  final String rateE8;
  final String rateSource;
  final int spreadBps;

  /// USDC at the mid-market rate
  final String baseTokenAmount;

  /// The spread, in USDC base units
  final String feeTokenAmount;

  Map<String, Object?> toJson() => _$QuotePricingToJson(this);
}
