// coverage:ignore-file
// GENERATED CODE - DO NOT MODIFY BY HAND
// ignore_for_file: type=lint, unused_import, invalid_annotation_target, unnecessary_import

import 'package:json_annotation/json_annotation.dart';

part 'tap_answer.g.dart';

@JsonSerializable()
class TapAnswer {
  const TapAnswer({
    required this.deviceId,
    required this.signature,
  });
  
  factory TapAnswer.fromJson(Map<String, Object?> json) => _$TapAnswerFromJson(json);
  
  final String deviceId;
  final String signature;

  Map<String, Object?> toJson() => _$TapAnswerToJson(this);
}
