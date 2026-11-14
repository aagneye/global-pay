// coverage:ignore-file
// GENERATED CODE - DO NOT MODIFY BY HAND
// ignore_for_file: type=lint, unused_import, invalid_annotation_target, unnecessary_import

import 'package:json_annotation/json_annotation.dart';

part 'p2p_transaction.g.dart';

@JsonSerializable()
class P2pTransaction {
  const P2pTransaction({
    required this.hash,
    required this.url,
  });
  
  factory P2pTransaction.fromJson(Map<String, Object?> json) => _$P2pTransactionFromJson(json);
  
  final String hash;
  final String url;

  Map<String, Object?> toJson() => _$P2pTransactionToJson(this);
}
