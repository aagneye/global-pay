// coverage:ignore-file
// GENERATED CODE - DO NOT MODIFY BY HAND
// ignore_for_file: type=lint, unused_import, invalid_annotation_target, unnecessary_import

import 'package:json_annotation/json_annotation.dart';

part 'eip712_domain.g.dart';

@JsonSerializable()
class Eip712Domain {
  const Eip712Domain({
    required this.name,
    required this.version,
    required this.chainId,
    required this.verifyingContract,
  });
  
  factory Eip712Domain.fromJson(Map<String, Object?> json) => _$Eip712DomainFromJson(json);
  
  final String name;
  final String version;
  final int chainId;
  final String verifyingContract;

  Map<String, Object?> toJson() => _$Eip712DomainToJson(this);
}
