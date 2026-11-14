// coverage:ignore-file
// GENERATED CODE - DO NOT MODIFY BY HAND
// ignore_for_file: type=lint, unused_import, invalid_annotation_target, unnecessary_import

import 'package:json_annotation/json_annotation.dart';

part 'approve_request.g.dart';

@JsonSerializable()
class ApproveRequest {
  const ApproveRequest({
    required this.signature,
  });
  
  factory ApproveRequest.fromJson(Map<String, Object?> json) => _$ApproveRequestFromJson(json);
  
  /// The sender's wallet signature over the TransferWithAuthorization
  final String signature;

  Map<String, Object?> toJson() => _$ApproveRequestToJson(this);
}
