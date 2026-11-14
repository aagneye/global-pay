// coverage:ignore-file
// GENERATED CODE - DO NOT MODIFY BY HAND
// ignore_for_file: type=lint, unused_import, invalid_annotation_target, unnecessary_import

import 'package:json_annotation/json_annotation.dart';

part 'transfer_domain.g.dart';

@JsonSerializable()
class TransferDomain {
  const TransferDomain({
    required this.name,
    required this.version,
    required this.chainId,
    required this.verifyingContract,
  });
  
  factory TransferDomain.fromJson(Map<String, Object?> json) => _$TransferDomainFromJson(json);
  
  final String name;
  final String version;
  final int chainId;
  final String verifyingContract;

  Map<String, Object?> toJson() => _$TransferDomainToJson(this);
}
