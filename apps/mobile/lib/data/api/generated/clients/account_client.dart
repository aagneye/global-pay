// coverage:ignore-file
// GENERATED CODE - DO NOT MODIFY BY HAND
// ignore_for_file: type=lint, unused_import, invalid_annotation_target, unnecessary_import

import 'package:dio/dio.dart';
import 'package:retrofit/retrofit.dart';

import '../models/balance.dart';
import '../models/deposit_list.dart';
import '../models/payment_list.dart';
import '../models/profile.dart';
import '../models/profile_update.dart';

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

  /// USDC that arrived in your wallet from outside, newest first (last 50).
  ///
  /// Found on-chain by the deposit watcher, a few blocks after they land. Refunds show on their payment instead.
  @GET('/me/deposits')
  Future<DepositList> listDeposits();

  /// Set the name others see when paying you
  @PUT('/me/profile')
  Future<Profile> updateProfile({
    @Body() required ProfileUpdate body,
  });
}
