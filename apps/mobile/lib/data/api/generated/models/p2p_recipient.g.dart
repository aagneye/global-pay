// GENERATED CODE - DO NOT MODIFY BY HAND

part of 'p2p_recipient.dart';

// **************************************************************************
// JsonSerializableGenerator
// **************************************************************************

P2pRecipient _$P2pRecipientFromJson(Map<String, dynamic> json) => P2pRecipient(
  name: json['name'] as String,
  verified: json['verified'] as bool,
  address: json['address'] as String,
);

Map<String, dynamic> _$P2pRecipientToJson(P2pRecipient instance) =>
    <String, dynamic>{
      'name': instance.name,
      'verified': instance.verified,
      'address': instance.address,
    };
