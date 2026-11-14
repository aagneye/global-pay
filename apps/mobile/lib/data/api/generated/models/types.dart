// coverage:ignore-file
// GENERATED CODE - DO NOT MODIFY BY HAND
// ignore_for_file: type=lint, unused_import, invalid_annotation_target, unnecessary_import

import 'package:json_annotation/json_annotation.dart';

part 'types.g.dart';

@JsonSerializable()
class Types {
  const Types({
    required this.name,
    required this.type,
  });
  
  factory Types.fromJson(Map<String, Object?> json) => _$TypesFromJson(json);
  
  final String name;
  final String type;

  Map<String, Object?> toJson() => _$TypesToJson(this);
}
