// coverage:ignore-file
// GENERATED CODE - DO NOT MODIFY BY HAND
// ignore_for_file: type=lint, unused_import, invalid_annotation_target, unnecessary_import

import 'package:json_annotation/json_annotation.dart';

import 'near_payment.dart';
import 'on_chain_quote.dart';
import 'quote_merchant.dart';
import 'quote_pricing.dart';
import 'receive_authorization_typed_data.dart';

part 'quote_response.g.dart';

@JsonSerializable()
class QuoteResponse {
  const QuoteResponse({
    required this.quote,
    required this.signature,
    required this.expiresAt,
    required this.pricing,
    required this.merchant,
    this.authorizationToSign,
    this.nearPayment,
  });
  
  factory QuoteResponse.fromJson(Map<String, Object?> json) => _$QuoteResponseFromJson(json);
  
  final OnChainQuote quote;

  /// GlobalPay's signature over the quote: EIP-712, 0x hex (EVM rail), or ed25519 over the quote JSON, base64 (NEAR rail)
  final String signature;
  final DateTime expiresAt;
  final QuotePricing pricing;
  final QuoteMerchant merchant;
  final ReceiveAuthorizationTypedData? authorizationToSign;
  final NearPayment? nearPayment;

  Map<String, Object?> toJson() => _$QuoteResponseToJson(this);
}
