// GENERATED CODE - DO NOT MODIFY BY HAND

part of 'quote_request.dart';

// **************************************************************************
// JsonSerializableGenerator
// **************************************************************************

QuoteRequest _$QuoteRequestFromJson(Map<String, dynamic> json) => QuoteRequest(
  payer: json['payer'] as String,
  qrPayload: json['qrPayload'] as String,
  fiatAmountMinor: json['fiatAmountMinor'] as String?,
);

Map<String, dynamic> _$QuoteRequestToJson(QuoteRequest instance) =>
    <String, dynamic>{
      'payer': instance.payer,
      'qrPayload': instance.qrPayload,
      'fiatAmountMinor': ?instance.fiatAmountMinor,
    };
