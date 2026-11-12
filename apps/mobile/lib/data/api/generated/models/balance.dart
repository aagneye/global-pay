// coverage:ignore-file
// GENERATED CODE - DO NOT MODIFY BY HAND
// ignore_for_file: type=lint, unused_import, invalid_annotation_target, unnecessary_import

import 'package:json_annotation/json_annotation.dart';

part 'balance.g.dart';

@JsonSerializable()
class Balance {
  const Balance({
    required this.token,
    required this.units,
    required this.decimals,
  });
  
  factory Balance.fromJson(Map<String, Object?> json) => _$BalanceFromJson(json);
  
  final String token;

  /// Token base units
  final String units;
  final int decimals;

  Map<String, Object?> toJson() => _$BalanceToJson(this);
}
