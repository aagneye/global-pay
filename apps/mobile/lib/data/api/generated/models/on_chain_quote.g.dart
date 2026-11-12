// GENERATED CODE - DO NOT MODIFY BY HAND

part of 'on_chain_quote.dart';

// **************************************************************************
// JsonSerializableGenerator
// **************************************************************************

OnChainQuote _$OnChainQuoteFromJson(Map<String, dynamic> json) => OnChainQuote(
  quoteId: json['quoteId'] as String,
  payer: json['payer'] as String,
  token: json['token'] as String,
  tokenAmount: json['tokenAmount'] as String,
  fiatCurrency: OnChainQuoteFiatCurrency.fromJson(
    json['fiatCurrency'] as String,
  ),
  fiatAmount: json['fiatAmount'] as String,
  merchantRefHash: json['merchantRefHash'] as String,
  expiresAt: (json['expiresAt'] as num).toInt(),
);

Map<String, dynamic> _$OnChainQuoteToJson(OnChainQuote instance) =>
    <String, dynamic>{
      'quoteId': instance.quoteId,
      'payer': instance.payer,
      'token': instance.token,
      'tokenAmount': instance.tokenAmount,
      'fiatCurrency': instance.fiatCurrency,
      'fiatAmount': instance.fiatAmount,
      'merchantRefHash': instance.merchantRefHash,
      'expiresAt': instance.expiresAt,
    };
