// coverage:ignore-file
// GENERATED CODE - DO NOT MODIFY BY HAND
// ignore_for_file: type=lint, unused_import, invalid_annotation_target, unnecessary_import

import 'package:json_annotation/json_annotation.dart';

import 'transfer_domain.dart';
import 'transfer_message.dart';
import 'transfer_to_sign_primary_type.dart';
import 'types.dart';

part 'transfer_to_sign.g.dart';

@JsonSerializable()
class TransferToSign {
  const TransferToSign({
    required this.domain,
    required this.types,
    required this.primaryType,
    required this.message,
  });
  
  factory TransferToSign.fromJson(Map<String, Object?> json) => _$TransferToSignFromJson(json);
  
  final TransferDomain domain;
  final Map<String, List<Types>> types;
  final TransferToSignPrimaryType primaryType;
  final TransferMessage message;

  Map<String, Object?> toJson() => _$TransferToSignToJson(this);
}
