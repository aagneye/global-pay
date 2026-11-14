// coverage:ignore-file
// GENERATED CODE - DO NOT MODIFY BY HAND
// ignore_for_file: type=lint, unused_import, invalid_annotation_target, unnecessary_import

import 'package:json_annotation/json_annotation.dart';

import 'deposit.dart';

part 'deposit_list.g.dart';

@JsonSerializable()
class DepositList {
  const DepositList({
    required this.deposits,
  });
  
  factory DepositList.fromJson(Map<String, Object?> json) => _$DepositListFromJson(json);
  
  final List<Deposit> deposits;

  Map<String, Object?> toJson() => _$DepositListToJson(this);
}
