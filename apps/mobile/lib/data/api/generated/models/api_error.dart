// coverage:ignore-file
// GENERATED CODE - DO NOT MODIFY BY HAND
// ignore_for_file: type=lint, unused_import, invalid_annotation_target, unnecessary_import

import 'package:json_annotation/json_annotation.dart';

part 'api_error.g.dart';

@JsonSerializable()
class ApiError {
  const ApiError({
    required this.error,
    this.message,
    this.issues,
  });
  
  factory ApiError.fromJson(Map<String, Object?> json) => _$ApiErrorFromJson(json);
  
  /// Stable machine-readable code
  final String error;
  final String? message;
  final List<dynamic>? issues;

  Map<String, Object?> toJson() => _$ApiErrorToJson(this);
}
