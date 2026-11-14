// coverage:ignore-file
// GENERATED CODE - DO NOT MODIFY BY HAND
// ignore_for_file: type=lint, unused_import, invalid_annotation_target, unnecessary_import

import 'package:json_annotation/json_annotation.dart';

import 'onramp_order.dart';

part 'onramp_order_list.g.dart';

@JsonSerializable()
class OnrampOrderList {
  const OnrampOrderList({
    required this.orders,
  });
  
  factory OnrampOrderList.fromJson(Map<String, Object?> json) => _$OnrampOrderListFromJson(json);
  
  final List<OnrampOrder> orders;

  Map<String, Object?> toJson() => _$OnrampOrderListToJson(this);
}
