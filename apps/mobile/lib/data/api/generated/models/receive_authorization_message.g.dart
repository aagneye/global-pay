// GENERATED CODE - DO NOT MODIFY BY HAND

part of 'receive_authorization_message.dart';

// **************************************************************************
// JsonSerializableGenerator
// **************************************************************************

ReceiveAuthorizationMessage _$ReceiveAuthorizationMessageFromJson(
  Map<String, dynamic> json,
) => ReceiveAuthorizationMessage(
  from: json['from'] as String,
  to: json['to'] as String,
  value: json['value'] as String,
  validAfter: json['validAfter'] as String,
  validBefore: json['validBefore'] as String,
  nonce: json['nonce'] as String,
);

Map<String, dynamic> _$ReceiveAuthorizationMessageToJson(
  ReceiveAuthorizationMessage instance,
) => <String, dynamic>{
  'from': instance.from,
  'to': instance.to,
  'value': instance.value,
  'validAfter': instance.validAfter,
  'validBefore': instance.validBefore,
  'nonce': instance.nonce,
};
