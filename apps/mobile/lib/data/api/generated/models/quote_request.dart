// coverage:ignore-file
// GENERATED CODE - DO NOT MODIFY BY HAND
// ignore_for_file: type=lint, unused_import, invalid_annotation_target, unnecessary_import

import 'package:json_annotation/json_annotation.dart';

part 'quote_request.g.dart';

@JsonSerializable()
class QuoteRequest {
  const QuoteRequest({
    required this.payer,
    required this.qrPayload,
    this.fiatAmountMinor,
  });
  
  factory QuoteRequest.fromJson(Map<String, Object?> json) => _$QuoteRequestFromJson(json);
  
  /// Wallet that will pay; must be the signed-in user's wallet
  final String payer;

  /// The scanned PromptPay QR text
  final String qrPayload;

  /// THB satang. Required when the QR has no amount; must match it when it has one.
  final String? fiatAmountMinor;

  Map<String, Object?> toJson() => _$QuoteRequestToJson(this);
}
