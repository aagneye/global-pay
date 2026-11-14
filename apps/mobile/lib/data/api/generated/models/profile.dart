// coverage:ignore-file
// GENERATED CODE - DO NOT MODIFY BY HAND
// ignore_for_file: type=lint, unused_import, invalid_annotation_target, unnecessary_import

import 'package:json_annotation/json_annotation.dart';

part 'profile.g.dart';

@JsonSerializable()
class Profile {
  const Profile({
    required this.displayName,
    required this.nameVerified,
  });
  
  factory Profile.fromJson(Map<String, Object?> json) => _$ProfileFromJson(json);
  
  final String displayName;
  final bool nameVerified;

  Map<String, Object?> toJson() => _$ProfileToJson(this);
}
