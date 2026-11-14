// coverage:ignore-file
// GENERATED CODE - DO NOT MODIFY BY HAND
// ignore_for_file: type=lint, unused_import, invalid_annotation_target, unnecessary_import

import 'package:dio/dio.dart';
import 'package:retrofit/retrofit.dart';

import '../models/onramp_checkout.dart';
import '../models/onramp_order.dart';
import '../models/onramp_order_list.dart';
import '../models/onramp_order_request.dart';

part 'onramp_client.g.dart';

@RestApi()
abstract class OnrampClient {
  factory OnrampClient(Dio dio, {String? baseUrl}) = _OnrampClient;

  /// Add money: start buying USDC with baht.
  ///
  /// Returns the partner's checkout page to open in the browser (a Custom Tab). The USDC goes to the signed-in user's wallet. Poll GET /onramp/orders/{id} until COMPLETED, FAILED or EXPIRED. checkoutUrl may be relative to the API (the local simulator).
  @POST('/onramp/orders')
  Future<OnrampCheckout> createOnrampOrder({
    @Body() required OnrampOrderRequest body,
  });

  /// Your Add-money orders, newest first (last 20)
  @GET('/onramp/orders')
  Future<OnrampOrderList> listOnrampOrders();

  /// An Add-money order, checked with the partner if due
  @GET('/onramp/orders/{id}')
  Future<OnrampOrder> getOnrampOrder({
    @Path('id') required String id,
  });
}
