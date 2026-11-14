import 'dart:convert';
import 'dart:typed_data';

import 'package:dio/dio.dart';

import 'fake_backend.dart';

/// Puts faults in front of a [FakeBackend]: per path, a network error, an error response, a slow answer or
/// any other reply instead of the fake's own. Paths without a fault get the fake's answer.
class FaultyBackend implements HttpClientAdapter {
  FaultyBackend(this.inner);

  final FakeBackend inner;

  /// The fault for a request path (e.g. `/auth/nonce`). Cleared with [faults.clear] or by removing the path.
  final faults = <String, Future<ResponseBody> Function(RequestOptions options)>{};

  /// A fault for every path that isn't matched by [faults], or null.
  Future<ResponseBody> Function(RequestOptions options)? everything;

  /// Every request path, faulted or not, in order.
  final calls = <String>[];

  @override
  Future<ResponseBody> fetch(RequestOptions options, Stream<Uint8List>? requestStream, Future<void>? cancelFuture) {
    calls.add(options.path);
    final fault = faults[options.path] ?? everything;
    return fault == null ? inner.fetch(options, requestStream, cancelFuture) : fault(options);
  }

  /// The fake backend's own answer, e.g. after a delay.
  Future<ResponseBody> passThrough(RequestOptions options) => inner.fetch(options, null, null);

  @override
  void close({bool force = false}) {}

  /// No connection: what Dio throws when the phone is offline.
  static Future<ResponseBody> Function(RequestOptions) offline([
    DioExceptionType type = DioExceptionType.connectionError,
  ]) =>
      (options) async => throw DioException(requestOptions: options, type: type, message: 'offline');

  /// An error response in the backend's `{error, message}` shape.
  static Future<ResponseBody> Function(RequestOptions) error(int status, String code, String message) =>
      (options) async => json(status, {'error': code, 'message': message});

  /// A response that isn't JSON, like a proxy's HTML error page.
  static Future<ResponseBody> Function(RequestOptions) html(int status) =>
      (options) async => ResponseBody.fromString(
        '<html><body>Bad Gateway</body></html>',
        status,
        headers: {
          Headers.contentTypeHeader: ['text/html'],
        },
      );

  static ResponseBody json(int status, Object body) => ResponseBody.fromString(
    jsonEncode(body),
    status,
    headers: {
      Headers.contentTypeHeader: [Headers.jsonContentType],
    },
  );
}
