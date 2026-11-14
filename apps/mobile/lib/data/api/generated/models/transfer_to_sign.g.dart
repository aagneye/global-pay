// GENERATED CODE - DO NOT MODIFY BY HAND

part of 'transfer_to_sign.dart';

// **************************************************************************
// JsonSerializableGenerator
// **************************************************************************

TransferToSign _$TransferToSignFromJson(Map<String, dynamic> json) =>
    TransferToSign(
      domain: TransferDomain.fromJson(json['domain'] as Map<String, dynamic>),
      types: (json['types'] as Map<String, dynamic>).map(
        (k, e) => MapEntry(
          k,
          (e as List<dynamic>)
              .map((e) => Types.fromJson(e as Map<String, dynamic>))
              .toList(),
        ),
      ),
      primaryType: TransferToSignPrimaryType.fromJson(
        json['primaryType'] as String,
      ),
      message: TransferMessage.fromJson(
        json['message'] as Map<String, dynamic>,
      ),
    );

Map<String, dynamic> _$TransferToSignToJson(TransferToSign instance) =>
    <String, dynamic>{
      'domain': instance.domain,
      'types': instance.types,
      'primaryType': instance.primaryType,
      'message': instance.message,
    };
