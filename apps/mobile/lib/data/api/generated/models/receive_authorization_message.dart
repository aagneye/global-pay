// coverage:ignore-file
// GENERATED CODE - DO NOT MODIFY BY HAND
// ignore_for_file: type=lint, unused_import, invalid_annotation_target, unnecessary_import

import 'package:json_annotation/json_annotation.dart';

part 'receive_authorization_message.g.dart';

@JsonSerializable()
class ReceiveAuthorizationMessage {
  const ReceiveAuthorizationMessage({
    required this.from,
    required this.to,
    required this.value,
    required this.validAfter,
    required this.validBefore,
    required this.nonce,
  });
  
  factory ReceiveAuthorizationMessage.fromJson(Map<String, Object?> json) => _$ReceiveAuthorizationMessageFromJson(json);
  
  final String from;
  final String to;
  final String value;
  final String validAfter;
  final String validBefore;
  final String nonce;

  Map<String, Object?> toJson() => _$ReceiveAuthorizationMessageToJson(this);
}
