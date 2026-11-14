import 'dart:convert';
import 'dart:typed_data';

import 'package:dio/dio.dart';

import 'fake_backend.dart';

/// What a [ScriptedBackend] handler returns to fail like a dropped connection (no response at all).
const offline = #offline;

/// A [FakeBackend] with some routes scripted by the test: a handler per "METHOD /path" answers instead of the
/// fake backend (a `(status, json)` pair, or [offline]), or rewrites the fake backend's JSON answer.
/// Every request is logged in [requests], whoever answered it.
class ScriptedBackend implements HttpClientAdapter {
  ScriptedBackend(this.inner);

  final FakeBackend inner;

  /// "GET /payments/payment_1" -> the answer (or [offline]); a handler answering null lets [inner] answer.
  final handlers = <String, Object? Function(Object? body)>{};

  /// "POST /quotes" -> changes [inner]'s JSON answer in place.
  final rewrites = <String, void Function(Map<String, dynamic> json)>{};

  final requests = <({String method, String path, Object? body})>[];

  /// The requests made to [method] [path].
  Iterable<Object?> bodies(String method, String path) =>
      requests.where((r) => r.method == method && r.path == path).map((r) => r.body);

  int count(String method, String path) => bodies(method, path).length;

  /// Answers "METHOD /path" with each of [answers] in turn, then keeps answering the last one.
  void sequence(String route, List<Object?> answers) {
    var next = 0;
    handlers[route] = (_) => answers[next < answers.length - 1 ? next++ : next];
  }

  @override
  Future<ResponseBody> fetch(
    RequestOptions options,
    Stream<Uint8List>? requestStream,
    Future<void>? cancelFuture,
  ) async {
    final body = options.data is String ? jsonDecode(options.data as String) : options.data;
    requests.add((method: options.method, path: options.path, body: body));
    final route = '${options.method} ${options.path}';
    if (handlers[route]?.call(body) case final answer?) {
      if (answer == offline) {
        throw DioException(requestOptions: options, type: DioExceptionType.connectionError, error: 'offline');
      }
      if (answer case (final int status, final Object? json)) return _json(status, json);
      throw ArgumentError.value(answer, route, 'not a (status, json) pair or offline');
    }
    final response = await inner.fetch(options, requestStream, cancelFuture);
    final rewrite = rewrites[route];
    if (rewrite == null) return response;
    final json = jsonDecode(await utf8.decodeStream(response.stream)) as Map<String, dynamic>;
    rewrite(json);
    return _json(response.statusCode, json);
  }

  ResponseBody _json(int status, Object? json) => ResponseBody.fromString(
    jsonEncode(json),
    status,
    headers: {
      Headers.contentTypeHeader: [Headers.jsonContentType],
    },
  );

  @override
  void close({bool force = false}) {}
}

/// A payment as GET /payments/:id and /me/payments return it (packages/openapi/openapi.json).
/// [currency] INR is a UPI payment to [merchantId] (a VPA); THB a PromptPay one.
Map<String, Object?> paymentJson({
  String id = FakeBackend.paymentId,
  String status = 'SUBMITTED',
  String currency = 'THB',
  String fiatAmount = '25000',
  String tokenAmount = '7477454',
  String? merchantName = 'GLOBALPAY TEST CAFE',
  String? merchantId,
  String? payoutStatus,
  String? payoutReference,
  String? failureReason,
  bool settleTx = false,
  bool refundTx = false,
  DateTime? createdAt,
}) {
  final upi = currency == 'INR';
  final at = (createdAt ?? DateTime.now()).toUtc().toIso8601String();
  String hash(String byte) => '0x${byte * 32}';
  Map<String, String> tx(String byte) => {'hash': hash(byte), 'url': 'https://explorer.test/tx/${hash(byte)}'};
  return {
    'id': id,
    'quoteId': FakeBackend.quoteId,
    'status': status,
    'fiatCurrency': currency,
    'fiatAmount': fiatAmount,
    'token': FakeBackend.nearUsdc,
    'tokenAmount': tokenAmount,
    'merchant': {
      'kind': upi ? 'upi' : 'merchant',
      'targetId': merchantId ?? (upi ? 'chaipoint@okicici' : '099999999999901'),
      if (merchantName != null) 'name': merchantName,
    },
    'transactions': {'pay': tx('22'), if (settleTx) 'settle': tx('33'), if (refundTx) 'refund': tx('44')},
    if (payoutStatus != null)
      'payout': {
        'status': payoutStatus,
        'provider': upi ? 'simulated-upi' : 'simulated-promptpay',
        if (payoutReference != null) 'reference': payoutReference,
      },
    if (failureReason != null) 'failureReason': failureReason,
    'quoteExpiresAt': at,
    'createdAt': at,
    'updatedAt': at,
  };
}
