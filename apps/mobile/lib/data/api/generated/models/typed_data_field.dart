// coverage:ignore-file
// GENERATED CODE - DO NOT MODIFY BY HAND
// ignore_for_file: type=lint, unused_import, invalid_annotation_target, unnecessary_import

import 'package:json_annotation/json_annotation.dart';

part 'typed_data_field.g.dart';

@JsonSerializable()
class TypedDataField {
  const TypedDataField({
    required this.name,
    required this.type,
  });
  
  factory TypedDataField.fromJson(Map<String, Object?> json) => _$TypedDataFieldFromJson(json);
  
  final String name;
  final String type;

  Map<String, Object?> toJson() => _$TypedDataFieldToJson(this);
}
