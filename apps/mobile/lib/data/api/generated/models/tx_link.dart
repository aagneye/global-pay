// coverage:ignore-file
// GENERATED CODE - DO NOT MODIFY BY HAND
// ignore_for_file: type=lint, unused_import, invalid_annotation_target, unnecessary_import

import 'package:json_annotation/json_annotation.dart';

part 'tx_link.g.dart';

@JsonSerializable()
class TxLink {
  const TxLink({
    required this.hash,
    required this.url,
  });
  
  factory TxLink.fromJson(Map<String, Object?> json) => _$TxLinkFromJson(json);
  
  final String hash;
  final String url;

  Map<String, Object?> toJson() => _$TxLinkToJson(this);
}
