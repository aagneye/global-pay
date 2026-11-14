// GENERATED CODE - DO NOT MODIFY BY HAND

part of 'transfer_domain.dart';

// **************************************************************************
// JsonSerializableGenerator
// **************************************************************************

TransferDomain _$TransferDomainFromJson(Map<String, dynamic> json) =>
    TransferDomain(
      name: json['name'] as String,
      version: json['version'] as String,
      chainId: (json['chainId'] as num).toInt(),
      verifyingContract: json['verifyingContract'] as String,
    );

Map<String, dynamic> _$TransferDomainToJson(TransferDomain instance) =>
    <String, dynamic>{
      'name': instance.name,
      'version': instance.version,
      'chainId': instance.chainId,
      'verifyingContract': instance.verifyingContract,
    };
