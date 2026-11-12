// GENERATED CODE - DO NOT MODIFY BY HAND

part of 'eip712_domain.dart';

// **************************************************************************
// JsonSerializableGenerator
// **************************************************************************

Eip712Domain _$Eip712DomainFromJson(Map<String, dynamic> json) => Eip712Domain(
  name: json['name'] as String,
  version: json['version'] as String,
  chainId: (json['chainId'] as num).toInt(),
  verifyingContract: json['verifyingContract'] as String,
);

Map<String, dynamic> _$Eip712DomainToJson(Eip712Domain instance) =>
    <String, dynamic>{
      'name': instance.name,
      'version': instance.version,
      'chainId': instance.chainId,
      'verifyingContract': instance.verifyingContract,
    };
