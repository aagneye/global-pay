// coverage:ignore-file
// GENERATED CODE - DO NOT MODIFY BY HAND
// ignore_for_file: type=lint, unused_import, invalid_annotation_target, unnecessary_import

import 'package:dio/dio.dart';
import 'package:retrofit/retrofit.dart';

import '../models/balance.dart';
import '../models/payment_list.dart';

part 'account_client.g.dart';

@RestApi()
abstract class AccountClient {
  factory AccountClient(Dio dio, {String? baseUrl}) = _AccountClient;

  /// USDC balance of the signed-in user's wallet
  @GET('/me/balance')
  Future<Balance> getBalance();

  /// Payment history, newest first (last 50)
  @GET('/me/payments')
  Future<PaymentList> listPayments();
}
