// coverage:ignore-file
// GENERATED CODE - DO NOT MODIFY BY HAND
// ignore_for_file: type=lint, unused_import, invalid_annotation_target, unnecessary_import

import 'package:json_annotation/json_annotation.dart';

import 'p2p_request.dart';

part 'p2p_request_list.g.dart';

@JsonSerializable()
class P2pRequestList {
  const P2pRequestList({
    required this.requests,
  });
  
  factory P2pRequestList.fromJson(Map<String, Object?> json) => _$P2pRequestListFromJson(json);
  
  final List<P2pRequest> requests;

  Map<String, Object?> toJson() => _$P2pRequestListToJson(this);
}
