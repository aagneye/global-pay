import 'dart:convert';
import 'dart:typed_data';

import 'package:blockchain_utils/blockchain_utils.dart';
import 'package:dio/dio.dart';
import 'package:globalpay/services/wallet/near/near_keys.dart';

/// A canned GlobalPay backend for widget tests, plugged into Dio below the generated client.
/// Responses follow packages/openapi/openapi.json.
class FakeBackend implements HttpClientAdapter {
  FakeBackend({
    this.balanceUnits = '10000000000',
    this.finalStatus = 'SETTLED',
    this.payoutStatus = 'PENDING',
    this.onrampFinalStatus = 'COMPLETED',
    this.p2pRole = 'receiver',
    this.near = false,
  });

  /// The NEAR rail (SETTLEMENT_RAIL=near): NEP-413 sign-in, quotes with a `nearPayment` to sign, payments with a
  /// `signedDelegate`; tap to pay, Add money and deposits answer 503.
  final bool near;

  /// NEAR rail: the test contracts, and the key that signed in (set by /auth/verify).
  static const nearUsdc = 'usdc.globalpay.testnet';
  static const nearSettlement = 'settle.globalpay.testnet';
  static const nearSignInRecipient = 'globalpay.local';
  static final nearNonce = List.generate(32, (i) => i.toRadixString(16).padLeft(2, '0')).join();
  String? nearPublicKey;

  /// NEAR rail: changes the `nearPayment` a quote asks the wallet to sign, like a compromised backend would.
  void Function(Map<String, dynamic> nearPayment)? tamperNear;

  final String balanceUnits;
  final String finalStatus;

  /// The payout's status while the payment is PAYOUT_PENDING, e.g. UNKNOWN.
  final String payoutStatus;
  static const bankReference = 'SIM0A1B2C3D4E5F';

  /// What an Add-money order becomes after the first check (it starts CREATED).
  final String onrampFinalStatus;
  int _onrampPolls = 0;
  bool _added = false;

  /// Which side of a tap payment this phone is on.
  final String p2pRole;
  String p2pStatus = 'CREATED';
  int _p2pPolls = 0;
  static final p2pChallenge = '0x${'c4' * 32}';
  static const receiverAddress = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8';
  final requests = <({String method, String path, Object? body, String? auth})>[];
  String kycStatus = 'NOT_STARTED';
  int _statusPolls = 0;
  bool _paid = false;

  static const quoteId = '0xabababababababababababababababababababababababababababababababab';
  static const paymentId = 'payment_1';

  /// Changes the typed data the backend asks the wallet to sign (a quote's or a tap payment's), like a
  /// compromised backend would.
  void Function(Map<String, Object?> typedData)? tamper;

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

  (int, Object?) _route(String method, String path, Object? body) {
    if (near) {
      if (_nearRoute(method, path, body) case final response?) return response;
    }
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
      ('POST', '/onramp/orders') => (201, {'order': _onramp('CREATED'), 'checkoutUrl': '/onramp/simulator/order_1'}),
      ('GET', '/onramp/orders/order_1') => () {
        final status = ++_onrampPolls < 2 ? 'CREATED' : onrampFinalStatus;
        _added = status == 'COMPLETED';
        return (200, _onramp(status));
      }(),
      ('GET', '/me/deposits') => (
        200,
        {
          'deposits': [
            if (_added) _deposit(),
            // The deposit worker also sees a tap payment's transfer arrive in the receiver's wallet.
            if (p2pRole == 'receiver' && p2pStatus == 'COMPLETED') _tapDeposit(),
          ],
        },
      ),
      ('POST', '/devices') => (201, {'id': 'device_1'}),
      ('DELETE', '/devices/device_1') => (204, null),
      ('PUT', '/me/profile') => (200, {'displayName': (body as Map)['displayName'], 'nameVerified': false}),
      ('POST', '/p2p/requests') => (201, _p2p()),
      ('POST', '/p2p/requests/request_1/tap') => () {
        p2pStatus = 'SENDER_IDENTIFIED';
        return (200, _p2p());
      }(),
      ('POST', '/p2p/requests/request_1/claim') => () {
        p2pStatus = 'SENDER_IDENTIFIED';
        return (200, _p2p());
      }(),
      ('GET', '/p2p/requests') => (200, {'requests': p2pStatus == 'CREATED' ? [] : [_p2p()]}),
      ('GET', '/p2p/incoming') => (200, {'requests': p2pStatus == 'SENDER_IDENTIFIED' ? [_p2p()] : []}),
      ('GET', '/p2p/requests/request_1') => () {
        // The other side acts between polls: the sender approves, then the transfer lands.
        if (++_p2pPolls > 1) {
          if (p2pRole == 'receiver' && p2pStatus == 'SENDER_IDENTIFIED') p2pStatus = 'COMPLETED';
          if (p2pStatus == 'SUBMITTED') p2pStatus = 'COMPLETED';
        }
        return (200, _p2p());
      }(),
      ('GET', '/p2p/requests/request_1/authorization') => (200, _transfer()),
      ('POST', '/p2p/requests/request_1/approve') => () {
        p2pStatus = 'SUBMITTED';
        return (200, _p2p());
      }(),
      ('POST', '/p2p/requests/request_1/decline') => () {
        p2pStatus = 'DECLINED';
        return (200, _p2p());
      }(),
      ('POST', '/p2p/requests/request_1/cancel') => () {
        p2pStatus = 'CANCELLED';
        return (200, _p2p());
      }(),
      _ => (404, {'error': 'not_found', 'message': 'No route $method $path'}),
    };
  }

  /// The NEAR rail's answers, or null where it answers like EVM (KYC, payment status, history, profile).
  (int, Object?)? _nearRoute(String method, String path, Object? body) {
    const notConfigured = (503, {'error': 'not_configured', 'message': 'Not available on the NEAR rail'});
    if (path.startsWith('/p2p') || path.startsWith('/onramp') || path.startsWith('/devices')) return notConfigured;
    final expiresAt = DateTime.now().add(const Duration(seconds: 60)).toUtc();
    return switch ((method, path)) {
      ('GET', '/me/deposits') => notConfigured,
      ('POST', '/auth/nonce') => (
        200,
        {
          'nonce': nearNonce,
          'message': 'globalpay.local wants you to sign in with your NEAR account:\n${(body as Map)['address']}',
          'expiresAt': expiresAt.toIso8601String(),
        },
      ),
      ('POST', '/auth/verify') => _nearVerify(body as Map),
      ('GET', '/me/balance') => (200, {'token': nearUsdc, 'units': balanceUnits, 'decimals': 6}),
      ('POST', '/quotes') => (201, _nearQuote((body as Map)['payer'] as String, expiresAt)),
      ('POST', '/payments') when (body as Map)['signedDelegate'] is! String || body.containsKey('signature') => (
        400,
        {'error': 'invalid_request', 'message': 'The NEAR rail needs signedDelegate'},
      ),
      _ => null,
    };
  }

  /// Checks the NEP-413 signature like the backend: by the key whose implicit account signed in.
  (int, Object?) _nearVerify(Map body) {
    final message = body['message'] as String;
    final publicKey = body['publicKey'] as String;
    final key = parseNearPublicKey(publicKey);
    final account = implicitAccountId(key);
    final digest = nep413Digest(
      message: message,
      nonce: BytesUtils.fromHexString(nearNonce),
      recipient: nearSignInRecipient,
    );
    final valid =
        message.endsWith('\n$account') &&
        Ed25519Verifier.fromKeyBytes(key).verify(digest, base64.decode(body['signature'] as String));
    if (!valid) return (401, {'error': 'invalid_signature', 'message': 'Signature does not match'});
    nearPublicKey = publicKey;
    return (
      200,
      {
        'token': 'test-token',
        'tokenType': 'Bearer',
        'expiresAt': DateTime.now().add(const Duration(days: 1)).toUtc().toIso8601String(),
        'user': {'id': 'user_1', 'walletAddress': account},
      },
    );
  }

  Map<String, Object> _nearQuote(String payer, DateTime expiresAt) {
    final quote = _quote(expiresAt)..remove('authorizationToSign');
    final onChain = quote['quote']! as Map<String, Object>;
    onChain['payer'] = payer;
    onChain['token'] = nearUsdc;
    final quoteJson = jsonEncode({
      'quote_id': quoteId,
      'payer': payer,
      'token': nearUsdc,
      'token_amount': onChain['tokenAmount'],
      'fiat_currency': 'THB',
      'fiat_amount': onChain['fiatAmount'],
      'merchant_ref_hash': onChain['merchantRefHash'],
      'expires_at_ms': expiresAt.millisecondsSinceEpoch,
    });
    final nearPayment = <String, dynamic>{
      'signerId': payer,
      'publicKey': nearPublicKey,
      'receiverId': nearUsdc,
      'methodName': 'ft_transfer_call',
      'args': {
        'receiver_id': nearSettlement,
        'amount': onChain['tokenAmount'],
        'msg': jsonEncode({'quote': quoteJson, 'signature': base64.encode(List.filled(64, 7))}),
      },
      'gas': '100000000000000',
      'deposit': '1',
      'nonce': '190000000000001',
      'maxBlockHeight': '187654321',
    };
    tamperNear?.call(nearPayment);
    return {...quote, 'signature': base64.encode(List.filled(64, 9)), 'nearPayment': nearPayment};
  }

  Map<String, Object> _p2p() {
    final now = DateTime.now().toUtc();
    return {
      'id': 'request_1',
      'role': p2pRole,
      'status': p2pStatus,
      'token': '0x5FbDB2315678afecb367f032d93F642f64180aa3',
      'amount': '5000000',
      'recipient': {'name': 'Somchai Coffee', 'verified': false, 'address': receiverAddress},
      if (p2pStatus != 'CREATED') 'sender': {'address': '0x15d34AAf54267DB7D7c367839AAf71A00a2C6A65'},
      if (p2pRole == 'receiver' && p2pStatus == 'CREATED') 'challenge': p2pChallenge,
      if (p2pStatus == 'SUBMITTED' || p2pStatus == 'COMPLETED')
        'transaction': {'hash': '0x${'66' * 32}', 'url': 'https://explorer.test/tx/0x${'66' * 32}'},
      'expiresAt': now.add(const Duration(minutes: 2)).toIso8601String(),
      'createdAt': now.toIso8601String(),
      'updatedAt': now.toIso8601String(),
    };
  }

  Map<String, Object?> _transfer() => _tampered({
    'domain': {'name': 'USDC', 'version': '2', 'chainId': 31337, 'verifyingContract': '0x5FbDB2315678afecb367f032d93F642f64180aa3'},
    'types': {
      'TransferWithAuthorization': [
        for (final (name, type) in [
          ('from', 'address'),
          ('to', 'address'),
          ('value', 'uint256'),
          ('validAfter', 'uint256'),
          ('validBefore', 'uint256'),
          ('nonce', 'bytes32'),
        ])
          {'name': name, 'type': type},
      ],
    },
    'primaryType': 'TransferWithAuthorization',
    'message': {
      'from': '0x15d34AAf54267DB7D7c367839AAf71A00a2C6A65',
      'to': receiverAddress,
      'value': '5000000',
      'validAfter': '0',
      // Like P2P_AUTHORIZATION_TTL_MS: 10 minutes.
      'validBefore': '${DateTime.now().add(const Duration(minutes: 10)).millisecondsSinceEpoch ~/ 1000}',
      'nonce': '0x${'77' * 32}',
    },
  });

  Map<String, Object?> _tampered(Map<String, Object?> typedData) {
    tamper?.call(typedData);
    return typedData;
  }

  Map<String, Object> _onramp(String status) {
    final now = DateTime.now().toUtc().toIso8601String();
    return {
      'id': 'order_1',
      'status': status,
      'provider': 'simulated-onramp',
      'fiatCurrency': 'THB',
      'fiatAmount': '80000',
      if (status == 'COMPLETED') 'tokenAmount': '24615384',
      if (status == 'COMPLETED') 'transaction': {'hash': '0x${'55' * 32}', 'url': 'https://explorer.test/tx/0x${'55' * 32}'},
      if (status == 'FAILED') 'failureReason': 'Card declined (simulated)',
      'expiresAt': now,
      'createdAt': now,
      'updatedAt': now,
    };
  }

  Map<String, Object> _deposit() => {
    'id': 'deposit_1',
    'token': '0x5FbDB2315678afecb367f032d93F642f64180aa3',
    'amount': '24615384',
    'from': '0x0000000000000000000000000000000000000000',
    'transaction': {'hash': '0x${'55' * 32}', 'url': 'https://explorer.test/tx/0x${'55' * 32}'},
    'onrampOrderId': 'order_1',
    'createdAt': DateTime.now().toUtc().toIso8601String(),
  };

  Map<String, Object> _tapDeposit() => {
    'id': 'deposit_2',
    'token': '0x5FbDB2315678afecb367f032d93F642f64180aa3',
    'amount': '5000000',
    'from': '0x15d34AAf54267DB7D7c367839AAf71A00a2C6A65',
    'transaction': {'hash': '0x${'66' * 32}', 'url': 'https://explorer.test/tx/0x${'66' * 32}'},
    'createdAt': DateTime.now().toUtc().toIso8601String(),
  };

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
      'authorizationToSign': _tampered({
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
      }),
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
      'token': near ? nearUsdc : '0x5FbDB2315678afecb367f032d93F642f64180aa3',
      'tokenAmount': '7477454',
      'merchant': {'kind': 'merchant', 'targetId': '099999999999901', 'name': 'GLOBALPAY TEST CAFE'},
      'transactions': {
        'pay': {'hash': '0x${'22' * 32}', 'url': 'https://explorer.test/tx/0x${'22' * 32}'},
        if (status == 'SETTLED') 'settle': {'hash': '0x${'33' * 32}', 'url': 'https://explorer.test/tx/0x${'33' * 32}'},
        if (status == 'REFUNDED')
          'refund': {'hash': '0x${'44' * 32}', 'url': 'https://explorer.test/tx/0x${'44' * 32}'},
      },
      if (switch (status) {
        'SETTLED' => 'SUCCEEDED',
        'REFUNDED' => 'FAILED',
        'PAYOUT_PENDING' => payoutStatus,
        _ => null,
      }
          case final payout?)
        'payout': {
          'status': payout,
          'provider': 'simulated-promptpay',
          if (payout == 'SUCCEEDED') 'reference': bankReference,
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
