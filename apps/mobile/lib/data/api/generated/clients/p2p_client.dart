// coverage:ignore-file
// GENERATED CODE - DO NOT MODIFY BY HAND
// ignore_for_file: type=lint, unused_import, invalid_annotation_target, unnecessary_import

import 'package:dio/dio.dart';
import 'package:retrofit/retrofit.dart';

import '../models/approve_request.dart';
import '../models/claim_request.dart';
import '../models/delete_devices_id_response_enum0.dart';
import '../models/device.dart';
import '../models/device_registration.dart';
import '../models/p2p_incoming_list.dart';
import '../models/p2p_request.dart';
import '../models/p2p_request_list.dart';
import '../models/payment_request_create.dart';
import '../models/tap_answer.dart';
import '../models/transfer_to_sign.dart';

part 'p2p_client.g.dart';

@RestApi()
abstract class P2pClient {
  factory P2pClient(Dio dio, {String? baseUrl}) = _P2pClient;

  /// Register this phone's hardware key (and push token) for tap to pay.
  ///
  /// Registering the same key again refreshes its push token. The returned ID is what the phone announces when tapped.
  @POST('/devices')
  Future<Device> registerDevice({
    @Body() required DeviceRegistration body,
  });

  /// Stop this phone being used to pay
  @DELETE('/devices/{id}')
  Future<DeleteDevicesIdResponseEnum0?> revokeDevice({
    @Path('id') required String id,
  });

  /// Ask someone to pay you (tap to pay, or they scan your QR).
  ///
  /// Expires after 2 minutes. Show the QR (request ID and challenge) or hold the other phone near yours.
  @POST('/p2p/requests')
  Future<P2pRequest> createPaymentRequest({
    @Body() required PaymentRequestCreate body,
  });

  /// Requests you received or paid, newest first (last 50)
  @GET('/p2p/requests')
  Future<P2pRequestList> listPaymentRequests();

  /// Requests waiting for your approval.
  ///
  /// Poll this while the tap screen is open, in case a push notification is slow or push is off.
  @GET('/p2p/incoming')
  Future<P2pIncomingList> listIncomingRequests();

  /// A request you received or are paying
  @GET('/p2p/requests/{id}')
  Future<P2pRequest> getPaymentRequest({
    @Path('id') required String id,
  });

  /// Receiver: forward the other phone's NFC answer.
  ///
  /// The device ID the other phone announced, and its P-256 signature (DER) over "GLOBALPAY-TAP-1" followed by the challenge.
  @POST('/p2p/requests/{id}/tap')
  Future<P2pRequest> tapPaymentRequest({
    @Path('id') required String id,
    @Body() required TapAnswer body,
  });

  /// Sender: claim a request from the receiver's QR
  @POST('/p2p/requests/{id}/claim')
  Future<P2pRequest> claimPaymentRequest({
    @Path('id') required String id,
    @Body() required ClaimRequest body,
  });

  /// Sender: the USDC transfer to sign (EIP-712 TransferWithAuthorization)
  @GET('/p2p/requests/{id}/authorization')
  Future<TransferToSign> getPaymentRequestAuthorization({
    @Path('id') required String id,
  });

  /// Sender: decline the request
  @POST('/p2p/requests/{id}/decline')
  Future<P2pRequest> declinePaymentRequest({
    @Path('id') required String id,
  });

  /// Receiver: cancel the request
  @POST('/p2p/requests/{id}/cancel')
  Future<P2pRequest> cancelPaymentRequest({
    @Path('id') required String id,
  });

  /// Sender: approve with the signed transfer; the backend relays it
  @POST('/p2p/requests/{id}/approve')
  Future<P2pRequest> approvePaymentRequest({
    @Path('id') required String id,
    @Body() required ApproveRequest body,
  });
}
