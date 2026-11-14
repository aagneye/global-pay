// coverage:ignore-file
// GENERATED CODE - DO NOT MODIFY BY HAND
// ignore_for_file: type=lint, unused_import, invalid_annotation_target, unnecessary_import

import 'package:json_annotation/json_annotation.dart';

import 'onramp_order.dart';

part 'onramp_checkout.g.dart';

@JsonSerializable()
class OnrampCheckout {
  const OnrampCheckout({
    required this.order,
    required this.checkoutUrl,
  });
  
  factory OnrampCheckout.fromJson(Map<String, Object?> json) => _$OnrampCheckoutFromJson(json);
  
  final OnrampOrder order;
  final String checkoutUrl;

  Map<String, Object?> toJson() => _$OnrampCheckoutToJson(this);
}
