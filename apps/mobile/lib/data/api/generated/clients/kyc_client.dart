// coverage:ignore-file
// GENERATED CODE - DO NOT MODIFY BY HAND
// ignore_for_file: type=lint, unused_import, invalid_annotation_target, unnecessary_import

import 'package:dio/dio.dart';
import 'package:retrofit/retrofit.dart';

import '../models/kyc_start.dart';
import '../models/kyc_status.dart';

part 'kyc_client.g.dart';

@RestApi()
abstract class KycClient {
  factory KycClient(Dio dio, {String? baseUrl}) = _KycClient;

  /// Start identity verification (mock: approved on the next status check)
  @POST('/kyc/start')
  Future<KycStart> startKyc();

  /// Verification status, tier and spending limits
  @GET('/kyc/status')
  Future<KycStatus> getKycStatus();
}
