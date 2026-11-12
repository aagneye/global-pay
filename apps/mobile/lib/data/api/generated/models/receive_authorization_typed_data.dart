// coverage:ignore-file
// GENERATED CODE - DO NOT MODIFY BY HAND
// ignore_for_file: type=lint, unused_import, invalid_annotation_target, unnecessary_import

import 'package:json_annotation/json_annotation.dart';

import 'eip712_domain.dart';
import 'receive_authorization_message.dart';
import 'receive_authorization_typed_data_primary_type.dart';
import 'typed_data_field.dart';

part 'receive_authorization_typed_data.g.dart';

/// EIP-712 typed data for the wallet (eth_signTypedData_v4): USDC ReceiveWithAuthorization
@JsonSerializable()
class ReceiveAuthorizationTypedData {
  const ReceiveAuthorizationTypedData({
    required this.types,
    required this.primaryType,
    required this.domain,
    required this.message,
  });
  
  factory ReceiveAuthorizationTypedData.fromJson(Map<String, Object?> json) => _$ReceiveAuthorizationTypedDataFromJson(json);
  
  final Map<String, List<TypedDataField>> types;
  final ReceiveAuthorizationTypedDataPrimaryType primaryType;
  final Eip712Domain domain;
  final ReceiveAuthorizationMessage message;

  Map<String, Object?> toJson() => _$ReceiveAuthorizationTypedDataToJson(this);
}
