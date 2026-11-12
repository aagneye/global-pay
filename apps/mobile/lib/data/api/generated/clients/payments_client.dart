// coverage:ignore-file
// GENERATED CODE - DO NOT MODIFY BY HAND
// ignore_for_file: type=lint, unused_import, invalid_annotation_target, unnecessary_import

import 'package:dio/dio.dart';
import 'package:retrofit/retrofit.dart';

import '../models/payment.dart';
import '../models/payment_request.dart';

part 'payments_client.g.dart';

@RestApi()
abstract class PaymentsClient {
  factory PaymentsClient(Dio dio, {String? baseUrl}) = _PaymentsClient;

  /// Pay a quote with the signed USDC authorisation.
  ///
  /// Checks the signature and limits, then relays pay() and returns at once with status SUBMITTED. Poll GET /payments/{id} until SETTLED, REFUNDED or FAILED. Submitting the same quote again returns the same payment.
  @POST('/payments')
  Future<Payment> submitPayment({
    @Body() required PaymentRequest body,
  });

  /// Payment status and transactions
  @GET('/payments/{id}')
  Future<Payment> getPayment({
    @Path('id') required String id,
  });
}
