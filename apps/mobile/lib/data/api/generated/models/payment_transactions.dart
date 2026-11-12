// coverage:ignore-file
// GENERATED CODE - DO NOT MODIFY BY HAND
// ignore_for_file: type=lint, unused_import, invalid_annotation_target, unnecessary_import

import 'package:json_annotation/json_annotation.dart';

import 'tx_link.dart';

part 'payment_transactions.g.dart';

@JsonSerializable()
class PaymentTransactions {
  const PaymentTransactions({
    this.pay,
    this.settle,
    this.refund,
  });
  
  factory PaymentTransactions.fromJson(Map<String, Object?> json) => _$PaymentTransactionsFromJson(json);
  
  final TxLink? pay;
  final TxLink? settle;
  final TxLink? refund;

  Map<String, Object?> toJson() => _$PaymentTransactionsToJson(this);
}
