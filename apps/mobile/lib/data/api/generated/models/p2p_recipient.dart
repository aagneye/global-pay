// coverage:ignore-file
// GENERATED CODE - DO NOT MODIFY BY HAND
// ignore_for_file: type=lint, unused_import, invalid_annotation_target, unnecessary_import

import 'package:json_annotation/json_annotation.dart';

part 'p2p_recipient.g.dart';

@JsonSerializable()
class P2pRecipient {
  const P2pRecipient({
    required this.name,
    required this.verified,
    required this.address,
  });
  
  factory P2pRecipient.fromJson(Map<String, Object?> json) => _$P2pRecipientFromJson(json);
  
  final String name;

  /// The name comes from identity verification
  final bool verified;
  final String address;

  Map<String, Object?> toJson() => _$P2pRecipientToJson(this);
}
