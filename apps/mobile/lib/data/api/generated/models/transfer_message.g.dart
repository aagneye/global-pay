// GENERATED CODE - DO NOT MODIFY BY HAND

part of 'transfer_message.dart';

// **************************************************************************
// JsonSerializableGenerator
// **************************************************************************

TransferMessage _$TransferMessageFromJson(Map<String, dynamic> json) =>
    TransferMessage(
      from: json['from'] as String,
      to: json['to'] as String,
      value: json['value'] as String,
      validAfter: json['validAfter'] as String,
      validBefore: json['validBefore'] as String,
      nonce: json['nonce'] as String,
    );

Map<String, dynamic> _$TransferMessageToJson(TransferMessage instance) =>
    <String, dynamic>{
      'from': instance.from,
      'to': instance.to,
      'value': instance.value,
      'validAfter': instance.validAfter,
      'validBefore': instance.validBefore,
      'nonce': instance.nonce,
    };
