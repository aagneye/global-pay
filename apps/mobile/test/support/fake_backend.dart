import 'dart:convert';
import 'dart:typed_data';

import 'package:dio/dio.dart';

/// A canned GlobalPay backend for widget tests, plugged into Dio below the generated client.
/// Responses follow packages/openapi/openapi.json.
class FakeBackend implements HttpClientAdapter {
  FakeBackend({this.balanceUnits = '10000000000', this.finalStatus = 'SETTLED'});

  final String balanceUnits;
  final String finalStatus;
  final requests = <({String method, String path, Object? body, String? auth})>[];
  String kycStatus = 'NOT_STARTED';
  int _statusPolls = 0;
  bool _paid = false;

  static const quoteId = '0xabababababababababababababababababababababababababababababababab';
  static const paymentId = 'payment_1';

  @override
  Future<ResponseBody> fetch(
    RequestOptions options,
    Stream<Uint8List>? requestStream,
    Future<void>? cancelFuture,
  ) async {
    final body = options.data is String ? jsonDecode(options.data as String) : options.data;
    requests.add((
      method: options.method,
      path: options.path,
      body: body,
      auth: options.headers['authorization'] as String?,
    ));
    // Like Fastify: an empty body labelled as JSON is a 400.
    final contentType = options.contentType ?? options.headers[Headers.contentTypeHeader] as String?;
    // Like the API's validation: optional fields are left out, never null.
    final hasNull = body is Map && body.values.contains(null);
    final (status, json) = hasNull
        ? (400, {'error': 'invalid_request', 'message': 'Optional fields must be left out, not null'})
        : body == null && (contentType?.contains('json') ?? false)
        ? (400, {'error': 'bad_request', 'message': 'Body cannot be empty when content-type is JSON'})
        : _route(options.method, options.path, body);
    return ResponseBody.fromString(
      jsonEncode(json),
      status,
      headers: {
        Headers.contentTypeHeader: [Headers.jsonContentType],
      },
    );
  }

  (int, Object) _route(String method, String path, Object? body) {
    final expiresAt = DateTime.now().add(const Duration(seconds: 60)).toUtc();
    return switch ((method, path)) {
      ('POST', '/auth/nonce') => (
        200,
        {
          'nonce': 'aBcD1234eFgH5678',
          'message': 'globalpay.local wants you to sign in with your Ethereum account:\n${(body as Map)['address']}',
          'expiresAt': expiresAt.toIso8601String(),
        },
      ),
      ('POST', '/auth/verify') => (
        200,
        {
          'token': 'test-token',
          'tokenType': 'Bearer',
          'expiresAt': DateTime.now().add(const Duration(days: 1)).toUtc().toIso8601String(),
          'user': {'id': 'user_1', 'walletAddress': '0x15d34aaf54267db7d7c367839aaf71a00a2c6a65'},
        },
      ),
      ('POST', '/kyc/start') => (200, {...?_kyc('PENDING'), 'session': null}),
      ('GET', '/kyc/status') => (200, _kyc(kycStatus == 'PENDING' ? 'APPROVED' : kycStatus)!),
      ('GET', '/me/balance') => (
        200,
        {'token': '0x5FbDB2315678afecb367f032d93F642f64180aa3', 'units': balanceUnits, 'decimals': 6},
      ),
      ('GET', '/me/payments') => (
        200,
        {
          'payments': _paid ? [_payment(finalStatus)] : [],
        },
      ),
      ('POST', '/quotes') => (201, _quote(expiresAt)),
      ('POST', '/payments') => () {
        _paid = true;
        return (202, _payment('SUBMITTED'));
      }(),
      ('GET', '/payments/$paymentId') => (200, _payment(++_statusPolls < 2 ? 'PAID' : finalStatus)),
      _ => (404, {'error': 'not_found', 'message': 'No route $method $path'}),
    };
  }

  Map<String, Object>? _kyc(String status) {
    kycStatus = status;
    final approved = status == 'APPROVED';
    return {
      'status': status,
      'tier': approved ? 1 : 0,
      'limits': {'perPayment': approved ? '500000' : '0', 'perDay': approved ? '2000000' : '0'},
    };
  }

  Map<String, Object> _quote(DateTime expiresAt) {
    final seconds = expiresAt.millisecondsSinceEpoch ~/ 1000;
    return {
      'quote': {
        'quoteId': quoteId,
        'payer': '0x15d34AAf54267DB7D7c367839AAf71A00a2C6A65',
        'token': '0x5FbDB2315678afecb367f032d93F642f64180aa3',
        'tokenAmount': '7477454',
        'fiatCurrency': 'THB',
        'fiatAmount': '25000',
        'merchantRefHash': '0xf00693116400736b2592210681da6a3d56654b34f739487ff2dfd42ad12d0efc',
        'expiresAt': seconds,
      },
      'signature': '0x${'11' * 65}',
      'expiresAt': DateTime.fromMillisecondsSinceEpoch(seconds * 1000, isUtc: true).toIso8601String(),
      'pricing': {
        'rateE8': '3376818073',
        'rateSource': 'coinbase',
        'spreadBps': 100,
        'baseTokenAmount': '7403420',
        'feeTokenAmount': '74034',
      },
      'merchant': {
        'kind': 'merchant',
        'targetType': 'biller',
        'targetId': '099999999999901',
        'reference1': 'INV0001',
        'merchantName': 'GLOBALPAY TEST CAFE',
        'merchantCity': 'BANGKOK',
      },
      'authorizationToSign': {
        'types': {
          'EIP712Domain': [
            {'name': 'name', 'type': 'string'},
            {'name': 'version', 'type': 'string'},
            {'name': 'chainId', 'type': 'uint256'},
            {'name': 'verifyingContract', 'type': 'address'},
          ],
          'ReceiveWithAuthorization': [
            {'name': 'from', 'type': 'address'},
            {'name': 'to', 'type': 'address'},
            {'name': 'value', 'type': 'uint256'},
            {'name': 'validAfter', 'type': 'uint256'},
            {'name': 'validBefore', 'type': 'uint256'},
            {'name': 'nonce', 'type': 'bytes32'},
          ],
        },
        'primaryType': 'ReceiveWithAuthorization',
        'domain': {
          'name': 'USDC',
          'version': '2',
          'chainId': 31337,
          'verifyingContract': '0x5FbDB2315678afecb367f032d93F642f64180aa3',
        },
        'message': {
          'from': '0x15d34AAf54267DB7D7c367839AAf71A00a2C6A65',
          'to': '0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512',
          'value': '7477454',
          'validAfter': '0',
          'validBefore': '$seconds',
          'nonce': quoteId,
        },
      },
    };
  }

  Map<String, Object> _payment(String status) {
    final now = DateTime.now().toUtc().toIso8601String();
    return {
      'id': paymentId,
      'quoteId': quoteId,
      'status': status,
      'fiatCurrency': 'THB',
      'fiatAmount': '25000',
      'token': '0x5FbDB2315678afecb367f032d93F642f64180aa3',
      'tokenAmount': '7477454',
      'merchant': {'kind': 'merchant', 'targetId': '099999999999901', 'name': 'GLOBALPAY TEST CAFE'},
      'transactions': {
        'pay': {'hash': '0x${'22' * 32}', 'url': 'https://explorer.test/tx/0x${'22' * 32}'},
        if (status == 'SETTLED') 'settle': {'hash': '0x${'33' * 32}', 'url': 'https://explorer.test/tx/0x${'33' * 32}'},
        if (status == 'REFUNDED')
          'refund': {'hash': '0x${'44' * 32}', 'url': 'https://explorer.test/tx/0x${'44' * 32}'},
      },
      if (status == 'REFUNDED') 'failureReason': 'Simulated payout failure (PAYOUT_FAILURE_RATE)',
      'quoteExpiresAt': now,
      'createdAt': now,
      'updatedAt': now,
    };
  }

  @override
  void close({bool force = false}) {}
}
