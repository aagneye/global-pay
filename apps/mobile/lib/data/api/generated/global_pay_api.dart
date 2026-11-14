// coverage:ignore-file
// GENERATED CODE - DO NOT MODIFY BY HAND
// ignore_for_file: type=lint, unused_import, invalid_annotation_target, unnecessary_import

import 'package:dio/dio.dart';

import 'clients/system_client.dart';
import 'clients/auth_client.dart';
import 'clients/kyc_client.dart';
import 'clients/quotes_client.dart';
import 'clients/payments_client.dart';
import 'clients/account_client.dart';
import 'clients/onramp_client.dart';
import 'clients/p2p_client.dart';

/// GlobalPay API `v0.1.0`.
///
/// Pay Thai PromptPay QRs with USDC on Base. Testnet demo: partners are simulated.
///
/// Money is sent as integer strings in minor units: THB satang ("10000" = 100.00 THB) and USDC base units ("1000000" = 1 USDC). Rates are THB per USDC × 1e8.
class GlobalPayApi {
  GlobalPayApi(
    Dio dio, {
    String? baseUrl,
  })  : _dio = dio,
        _baseUrl = baseUrl;

  final Dio _dio;
  final String? _baseUrl;

  static String get version => '0.1.0';

  SystemClient? _system;
  AuthClient? _auth;
  KycClient? _kyc;
  QuotesClient? _quotes;
  PaymentsClient? _payments;
  AccountClient? _account;
  OnrampClient? _onramp;
  P2pClient? _p2p;

  SystemClient get system => _system ??= SystemClient(_dio, baseUrl: _baseUrl);

  AuthClient get auth => _auth ??= AuthClient(_dio, baseUrl: _baseUrl);

  KycClient get kyc => _kyc ??= KycClient(_dio, baseUrl: _baseUrl);

  QuotesClient get quotes => _quotes ??= QuotesClient(_dio, baseUrl: _baseUrl);

  PaymentsClient get payments => _payments ??= PaymentsClient(_dio, baseUrl: _baseUrl);

  AccountClient get account => _account ??= AccountClient(_dio, baseUrl: _baseUrl);

  OnrampClient get onramp => _onramp ??= OnrampClient(_dio, baseUrl: _baseUrl);

  P2pClient get p2p => _p2p ??= P2pClient(_dio, baseUrl: _baseUrl);
}
