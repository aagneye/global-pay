// GENERATED CODE - DO NOT MODIFY BY HAND

part of 'quote_response.dart';

// **************************************************************************
// JsonSerializableGenerator
// **************************************************************************

QuoteResponse _$QuoteResponseFromJson(Map<String, dynamic> json) =>
    QuoteResponse(
      quote: OnChainQuote.fromJson(json['quote'] as Map<String, dynamic>),
      signature: json['signature'] as String,
      expiresAt: DateTime.parse(json['expiresAt'] as String),
      pricing: QuotePricing.fromJson(json['pricing'] as Map<String, dynamic>),
      merchant: QuoteMerchant.fromJson(
        json['merchant'] as Map<String, dynamic>,
      ),
      authorizationToSign: json['authorizationToSign'] == null
          ? null
          : ReceiveAuthorizationTypedData.fromJson(
              json['authorizationToSign'] as Map<String, dynamic>,
            ),
      nearPayment: json['nearPayment'] == null
          ? null
          : NearPayment.fromJson(json['nearPayment'] as Map<String, dynamic>),
    );

Map<String, dynamic> _$QuoteResponseToJson(QuoteResponse instance) =>
    <String, dynamic>{
      'quote': instance.quote,
      'signature': instance.signature,
      'expiresAt': instance.expiresAt.toIso8601String(),
      'pricing': instance.pricing,
      'merchant': instance.merchant,
      'authorizationToSign': ?instance.authorizationToSign,
      'nearPayment': ?instance.nearPayment,
    };
