// coverage:ignore-file
// GENERATED CODE - DO NOT MODIFY BY HAND
// ignore_for_file: type=lint, unused_import, invalid_annotation_target, unnecessary_import

import 'package:json_annotation/json_annotation.dart';

part 'p2p_sender.g.dart';

@JsonSerializable()
class P2pSender {
  const P2pSender({
    required this.address,
  });
  
  factory P2pSender.fromJson(Map<String, Object?> json) => _$P2pSenderFromJson(json);
  
  final String address;

  Map<String, Object?> toJson() => _$P2pSenderToJson(this);
}
