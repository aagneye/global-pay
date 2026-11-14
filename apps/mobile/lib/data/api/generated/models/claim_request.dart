// coverage:ignore-file
// GENERATED CODE - DO NOT MODIFY BY HAND
// ignore_for_file: type=lint, unused_import, invalid_annotation_target, unnecessary_import

import 'package:json_annotation/json_annotation.dart';

part 'claim_request.g.dart';

@JsonSerializable()
class ClaimRequest {
  const ClaimRequest({
    required this.challenge,
  });
  
  factory ClaimRequest.fromJson(Map<String, Object?> json) => _$ClaimRequestFromJson(json);
  
  final String challenge;

  Map<String, Object?> toJson() => _$ClaimRequestToJson(this);
}
