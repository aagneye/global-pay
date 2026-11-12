import 'package:dio/dio.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:globalpay/core/config/app_config.dart';
import 'package:globalpay/core/errors/app_exception.dart';
import 'package:globalpay/core/storage/secure_store.dart';
import 'package:globalpay/data/api/api_client.dart';
import 'package:globalpay/data/session_store.dart';
import 'package:globalpay/domain/models/session.dart';

import '../support/fake_backend.dart';

const config = AppConfig(apiBaseUrl: 'http://backend.test', chainId: 31337);

void main() {
  group('SessionStore', () {
    final now = DateTime.utc(2026, 11, 12, 12);
    Session session({Duration validFor = const Duration(hours: 1)}) =>
        Session(token: 't', expiresAt: now.add(validFor), userId: 'u', walletAddress: '0xabc');

    test('saves and restores a valid session', () async {
      final storage = MemorySecureStore();
      await SessionStore(storage, clock: () => now).save(session());

      final restored = await SessionStore(storage, clock: () => now).load();
      expect(restored?.token, 't');
      expect(restored?.expiresAt, now.add(const Duration(hours: 1)));
    });

    test('forgets an expired or unreadable session', () async {
      final storage = MemorySecureStore();
      await SessionStore(storage, clock: () => now).save(session(validFor: const Duration(seconds: 30)));
      expect(await SessionStore(storage, clock: () => now).load(), isNull);
      expect(storage.values, isEmpty);

      storage.values[SessionStore.storageKey] = 'not json';
      expect(await SessionStore(storage, clock: () => now).load(), isNull);
      expect(storage.values, isEmpty);
    });

    test('stops returning the session once it expires', () async {
      var clock = now;
      final store = SessionStore(MemorySecureStore(), clock: () => clock);
      await store.save(session());
      expect(store.current, isNotNull);
      clock = now.add(const Duration(minutes: 59, seconds: 30));
      expect(store.current, isNull);
    });
  });

  group('ApiClient', () {
    ApiClient client(FakeBackend backend, {String? token, void Function()? onUnauthorized}) =>
        ApiClient(config, token: () => token, onUnauthorized: onUnauthorized, dio: Dio()..httpClientAdapter = backend);

    test('sends the bearer token when signed in', () async {
      final backend = FakeBackend();
      await client(backend, token: 'abc').api.account.getBalance();
      await client(backend).api.account.getBalance();
      expect(backend.requests.map((r) => r.auth), ['Bearer abc', null]);
    });

    test("turns the backend's errors into AppExceptions with its code", () async {
      final error = await ApiClient.call(
        () => client(FakeBackend()).api.payments.getPayment(id: 'missing'),
      ).then<Object?>((_) => null, onError: (Object e) => e);
      expect(error, isA<AppException>().having((e) => e.code, 'code', 'not_found'));
    });

    test('reports unreachable servers as network errors', () {
      final exception = ApiClient.toAppException(
        DioException(requestOptions: RequestOptions(), type: DioExceptionType.connectionError),
      );
      expect(exception.code, 'network_error');
    });

    test('signs out on 401', () async {
      var signedOut = false;
      final dio = Dio()
        ..httpClientAdapter = _Status401()
        ..options.baseUrl = 'http://backend.test';
      final api = ApiClient(config, token: () => 'expired', onUnauthorized: () => signedOut = true, dio: dio);
      await expectLater(ApiClient.call(() => api.api.kyc.getKycStatus()), throwsA(isA<AppException>()));
      expect(signedOut, isTrue);
    });
  });
}

class _Status401 implements HttpClientAdapter {
  @override
  Future<ResponseBody> fetch(
    RequestOptions options,
    Stream<List<int>>? requestStream,
    Future<void>? cancelFuture,
  ) async => ResponseBody.fromString(
    '{"error":"invalid_token","message":"The access token is invalid or expired; sign in again"}',
    401,
    headers: {
      Headers.contentTypeHeader: [Headers.jsonContentType],
    },
  );

  @override
  void close({bool force = false}) {}
}
