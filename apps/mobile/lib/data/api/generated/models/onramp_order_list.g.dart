// GENERATED CODE - DO NOT MODIFY BY HAND

part of 'onramp_order_list.dart';

// **************************************************************************
// JsonSerializableGenerator
// **************************************************************************

OnrampOrderList _$OnrampOrderListFromJson(Map<String, dynamic> json) =>
    OnrampOrderList(
      orders: (json['orders'] as List<dynamic>)
          .map((e) => OnrampOrder.fromJson(e as Map<String, dynamic>))
          .toList(),
    );

Map<String, dynamic> _$OnrampOrderListToJson(OnrampOrderList instance) =>
    <String, dynamic>{'orders': instance.orders};
