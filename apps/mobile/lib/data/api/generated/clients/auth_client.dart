// coverage:ignore-file
// GENERATED CODE - DO NOT MODIFY BY HAND
// ignore_for_file: type=lint, unused_import, invalid_annotation_target, unnecessary_import

import 'package:dio/dio.dart';
import 'package:retrofit/retrofit.dart';

import '../models/nonce_request.dart';
import '../models/nonce_response.dart';
import '../models/sign_in_request.dart';
import '../models/sign_in_response.dart';

part 'auth_client.g.dart';

@RestApi()
abstract class AuthClient {
  factory AuthClient(Dio dio, {String? baseUrl}) = _AuthClient;

  /// Start sign-in: get a one-time nonce and the message to sign
  @POST('/auth/nonce')
  Future<NonceResponse> createSignInNonce({
    @Body() required NonceRequest body,
  });

  /// Finish sign-in: verify the signed message and get an access token
  @POST('/auth/verify')
  Future<SignInResponse> verifySignIn({
    @Body() required SignInRequest body,
  });
}
