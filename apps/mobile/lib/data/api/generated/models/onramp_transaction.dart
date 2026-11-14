// coverage:ignore-file
// GENERATED CODE - DO NOT MODIFY BY HAND
// ignore_for_file: type=lint, unused_import, invalid_annotation_target, unnecessary_import

import 'package:json_annotation/json_annotation.dart';

part 'onramp_transaction.g.dart';

@JsonSerializable()
class OnrampTransaction {
  const OnrampTransaction({
    required this.hash,
    required this.url,
  });
  
  factory OnrampTransaction.fromJson(Map<String, Object?> json) => _$OnrampTransactionFromJson(json);
  
  final String hash;
  final String url;

  Map<String, Object?> toJson() => _$OnrampTransactionToJson(this);
}
