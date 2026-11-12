// GENERATED CODE - DO NOT MODIFY BY HAND

part of 'receive_authorization_typed_data.dart';

// **************************************************************************
// JsonSerializableGenerator
// **************************************************************************

ReceiveAuthorizationTypedData _$ReceiveAuthorizationTypedDataFromJson(
  Map<String, dynamic> json,
) => ReceiveAuthorizationTypedData(
  types: (json['types'] as Map<String, dynamic>).map(
    (k, e) => MapEntry(
      k,
      (e as List<dynamic>)
          .map((e) => TypedDataField.fromJson(e as Map<String, dynamic>))
          .toList(),
    ),
  ),
  primaryType: ReceiveAuthorizationTypedDataPrimaryType.fromJson(
    json['primaryType'] as String,
  ),
  domain: Eip712Domain.fromJson(json['domain'] as Map<String, dynamic>),
  message: ReceiveAuthorizationMessage.fromJson(
    json['message'] as Map<String, dynamic>,
  ),
);

Map<String, dynamic> _$ReceiveAuthorizationTypedDataToJson(
  ReceiveAuthorizationTypedData instance,
) => <String, dynamic>{
  'types': instance.types,
  'primaryType': instance.primaryType,
  'domain': instance.domain,
  'message': instance.message,
};
