// GENERATED CODE - DO NOT MODIFY BY HAND

part of 'onramp_checkout.dart';

// **************************************************************************
// JsonSerializableGenerator
// **************************************************************************

OnrampCheckout _$OnrampCheckoutFromJson(Map<String, dynamic> json) =>
    OnrampCheckout(
      order: OnrampOrder.fromJson(json['order'] as Map<String, dynamic>),
      checkoutUrl: json['checkoutUrl'] as String,
    );

Map<String, dynamic> _$OnrampCheckoutToJson(OnrampCheckout instance) =>
    <String, dynamic>{
      'order': instance.order,
      'checkoutUrl': instance.checkoutUrl,
    };
