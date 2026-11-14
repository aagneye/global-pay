// coverage:ignore-file
// GENERATED CODE - DO NOT MODIFY BY HAND
// ignore_for_file: type=lint, unused_import, invalid_annotation_target, unnecessary_import

import 'package:dio/dio.dart';
import 'package:retrofit/retrofit.dart';

import '../models/quote_request.dart';
import '../models/quote_response.dart';

part 'quotes_client.g.dart';

@RestApi()
abstract class QuotesClient {
  factory QuotesClient(Dio dio, {String? baseUrl}) = _QuotesClient;

  /// Quote a PromptPay or UPI QR payment in USDC.
  ///
  /// Parses the QR (PromptPay: THB, UPI: INR), checks KYC limits, prices it at the live rate plus the spread, and signs it. The quote expires after QUOTE_TTL_SECONDS (60 s by default). EVM rail: sign `authorizationToSign` with the payer wallet. NEAR rail: sign `nearPayment` as a delegate action. Then submit it to POST /payments.
  @POST('/quotes')
  Future<QuoteResponse> createQuote({
    @Body() required QuoteRequest body,
  });
}
