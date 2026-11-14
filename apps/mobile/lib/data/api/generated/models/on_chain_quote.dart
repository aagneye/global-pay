// coverage:ignore-file
// GENERATED CODE - DO NOT MODIFY BY HAND
// ignore_for_file: type=lint, unused_import, invalid_annotation_target, unnecessary_import

import 'package:json_annotation/json_annotation.dart';

import 'on_chain_quote_fiat_currency.dart';

part 'on_chain_quote.g.dart';

/// The on-chain Quote struct, as signed. Send it back unchanged with the payment.
@JsonSerializable()
class OnChainQuote {
  const OnChainQuote({
    required this.quoteId,
    required this.payer,
    required this.token,
    required this.tokenAmount,
    required this.fiatCurrency,
    required this.fiatAmount,
    required this.merchantRefHash,
    required this.expiresAt,
  });
  
  factory OnChainQuote.fromJson(Map<String, Object?> json) => _$OnChainQuoteFromJson(json);
  
  final String quoteId;

  /// 0x address (EVM rail) or NEAR implicit account (NEAR rail)
  final String payer;

  /// USDC: its 0x address (EVM rail) or contract account ID (NEAR rail)
  final String token;

  /// USDC base units (6 decimals), spread included
  final String tokenAmount;
  final OnChainQuoteFiatCurrency fiatCurrency;

  /// THB satang the merchant receives
  final String fiatAmount;
  final String merchantRefHash;

  /// Unix seconds
  final int expiresAt;

  Map<String, Object?> toJson() => _$OnChainQuoteToJson(this);
}
