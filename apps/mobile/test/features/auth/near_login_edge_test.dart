import 'dart:async';

import 'package:dio/dio.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:globalpay/app/app.dart';
import 'package:globalpay/core/errors/app_exception.dart';
import 'package:globalpay/core/providers.dart';
import 'package:globalpay/core/storage/secure_store.dart';
import 'package:globalpay/data/api/api_client.dart';
import 'package:globalpay/data/session_store.dart';
import 'package:globalpay/domain/models/session.dart';
import 'package:globalpay/features/auth/session_controller.dart';
import 'package:globalpay/features/card_key/card_key_screen.dart';
import 'package:globalpay/features/scan/scan_screen.dart';
import 'package:globalpay/services/card_key/card_key_store.dart';
import 'package:globalpay/services/push/push_service.dart';
import 'package:globalpay/services/wallet/signature_gate.dart';
import 'package:globalpay/services/wallet/near/near_wallet_service.dart';

import '../../near_flow_test.dart' show continueWithNear, nearConfig, pumpUntil, qr250, start, tap;
import '../../support/fake_backend.dart';
import '../../support/fake_card_reader.dart';
import '../../support/fake_tap.dart';
import '../../support/faulty_backend.dart';
import '../../support/near_vectors.dart';
import '../../support/spy_near_wallet.dart';

const offlineMessage = "Can't reach GlobalPay. Check your connection and try again.";
const genericMessage = 'Something went wrong. Please try again.';
const rejectedMessage = 'Your verification was not approved. You can try again.';

/// The NEAR wallet with switchable failures: making or loading the key, and signing the sign-in message.
class FailingNearWallet extends SpyNearWallet {
  FailingNearWallet({required super.store, this.connectError, this.signError}) : super(importSeed: nearTestSeed);

  Object? connectError;
  Object? signError;
  var signAttempts = 0;

  @override
  Future<String> connect() async {
    if (connectError case final error?) throw error;
    return super.connect();
  }

  @override
  Future<String> signNep413(
    String message,
    List<int> nonce,
    String recipient, {
    String reason = 'Sign in to GlobalPay',
  }) async {
    signAttempts++;
    if (signError case final error?) throw error;
    return super.signNep413(message, nonce, recipient, reason: reason);
  }
}

/// The app on the NEAR rail like `nearApp`, but wired like production: a 401 from the backend expires the session.
Widget authApp(HttpClientAdapter backend, SecureStore store, NearWalletService wallet, {bool onboarding = false}) {
  const config = nearConfig;
  return ProviderScope(
    overrides: [
      appConfigProvider.overrideWithValue(config),
      cardReaderProvider.overrideWithValue(FakeCardReader()),
      cardKeyOnboardingProvider.overrideWithValue(onboarding),
      secureStoreProvider.overrideWithValue(store),
      nearWalletProvider.overrideWithValue(wallet),
      keyVaultProvider.overrideWithValue(null),
      apiClientProvider.overrideWith((ref) {
        final sessions = ref.watch(sessionStoreProvider);
        return ApiClient(
          config,
          token: () => sessions.current?.token,
          onUnauthorized: () => ref.read(sessionProvider.notifier).expire(),
          dio: Dio()..httpClientAdapter = backend,
        );
      }),
      cameraScannerProvider.overrideWithValue(false),
      tapCardProvider.overrideWithValue(FakeTapCard()),
      tapReaderProvider.overrideWithValue(FakeTapReader()),
      pushServiceProvider.overrideWithValue(const NoPushService()),
    ],
    child: const GlobalPayApp(),
  );
}

/// The sign-in button, enabled or not.
FilledButton nearButton(WidgetTester tester) => tester.widget<FilledButton>(find.byType(FilledButton).last);

bool hasSession(MemorySecureStore store) => store.values.containsKey(SessionStore.storageKey);

Iterable<String> paths(FakeBackend backend, String path) =>
    backend.requests.where((r) => r.path == path).map((r) => r.path);

/// Pumps until [shown] is on screen and [gone] isn't (the page before has finished sliding away).
Future<void> pumpUntilOnly(WidgetTester tester, Finder shown, Finder gone) async {
  for (var i = 0; i < 100; i++) {
    await tester.pump(const Duration(milliseconds: 100));
    if (shown.evaluate().isNotEmpty && gone.evaluate().isEmpty) return;
  }
  final texts = tester.widgetList<Text>(find.byType(Text)).map((t) => t.data).join(' | ');
  fail('Did not find only $shown. On screen: $texts');
}

/// Home, with the sign-in page gone.
Future<void> pumpUntilHome(WidgetTester tester) =>
    pumpUntilOnly(tester, find.text('Scan & pay'), find.text(continueWithNear));

/// Sign-in, with Home gone.
Future<void> pumpUntilSignIn(WidgetTester tester) =>
    pumpUntilOnly(tester, find.text(continueWithNear), find.text('Scan & pay'));

Future<void> signOutFromHome(WidgetTester tester) async {
  await tester.tap(find.byTooltip('Menu'));
  await tester.pump();
  await tester.pump(const Duration(seconds: 1));
  await tap(tester, 'Sign out');
  await pumpUntilSignIn(tester);
}

void main() {
  late FakeBackend backend;
  late FaultyBackend faulty;
  late MemorySecureStore store;

  setUp(() {
    backend = FakeBackend(near: true)..kycStatus = 'APPROVED';
    faulty = FaultyBackend(backend);
    store = MemorySecureStore();
  });

  Future<FailingNearWallet> open(WidgetTester tester, {bool onboarding = false}) async {
    final wallet = FailingNearWallet(store: store);
    await start(tester, authApp(faulty, store, wallet, onboarding: onboarding));
    await pumpUntil(tester, find.text(continueWithNear));
    return wallet;
  }

  group('the nonce request fails', () {
    testWidgets('offline: says so, signs nothing, and trying again signs in', (tester) async {
      faulty.faults['/auth/nonce'] = FaultyBackend.offline();
      final wallet = await open(tester);

      await tap(tester, continueWithNear);
      await pumpUntil(tester, find.text(offlineMessage));
      expect(wallet.signAttempts, 0);
      expect(paths(backend, '/auth/verify'), isEmpty);
      expect(hasSession(store), isFalse);
      expect(nearButton(tester).onPressed, isNotNull);

      faulty.faults.clear();
      await tap(tester, continueWithNear);
      await pumpUntil(tester, find.text('Scan & pay'));
      expect(find.text(offlineMessage), findsNothing);
      expect(hasSession(store), isTrue);
    });

    testWidgets("a 5xx with the backend's error shows its message and stays signed out", (tester) async {
      faulty.faults['/auth/nonce'] = FaultyBackend.error(503, 'unavailable', 'GlobalPay is briefly unavailable.');
      final wallet = await open(tester);

      await tap(tester, continueWithNear);
      await pumpUntil(tester, find.text('GlobalPay is briefly unavailable.'));
      expect(wallet.signAttempts, 0);
      expect(find.text('Scan & pay'), findsNothing);
      expect(hasSession(store), isFalse);
    });

    testWidgets(
      'a 502 page that is not JSON shows a plain error, not the HTTP library text',
      (tester) async {
        faulty.faults['/auth/nonce'] = FaultyBackend.html(502);
        final wallet = await open(tester);

        await tap(tester, continueWithNear);
        await pumpUntil(tester, find.byIcon(Icons.error_outline));
        expect(wallet.signAttempts, 0);
        expect(hasSession(store), isFalse);
        expect(find.textContaining('validateStatus'), findsNothing);
        expect(find.textContaining('RequestOptions'), findsNothing);
      },
    );

    testWidgets("a nonce that isn't 32 bytes is refused before the wallet signs", (tester) async {
      faulty.faults['/auth/nonce'] = (options) async => FaultyBackend.json(200, {
        'nonce': 'aBcD1234eFgH5678',
        'message': 'globalpay.local wants you to sign in with your NEAR account:\n$nearTestAccount',
        'expiresAt': DateTime.now().add(const Duration(minutes: 1)).toUtc().toIso8601String(),
      });
      final wallet = await open(tester);

      await tap(tester, continueWithNear);
      await pumpUntil(tester, find.text("GlobalPay sent a sign-in request this wallet can't sign."));
      expect(wallet.signAttempts, 0);
      expect(wallet.signedMessages, isEmpty);
      expect(paths(backend, '/auth/verify'), isEmpty);
    });
  });

  group('verify rejects the sign-in', () {
    testWidgets('401 (expired nonce): shows why; the 401 handler leaves the signed-out user on sign-in', (
      tester,
    ) async {
      faulty.faults['/auth/verify'] = FaultyBackend.error(401, 'nonce_expired', 'This sign-in request expired.');
      final wallet = await open(tester);

      await tap(tester, continueWithNear);
      await pumpUntil(tester, find.text('This sign-in request expired.'));
      expect(wallet.signedMessages, hasLength(1));
      expect(hasSession(store), isFalse);
      expect(nearButton(tester).onPressed, isNotNull);

      // Trying again asks for a fresh nonce and signs in.
      faulty.faults.clear();
      await tap(tester, continueWithNear);
      await pumpUntil(tester, find.text('Scan & pay'));
      expect(faulty.calls.where((p) => p == '/auth/nonce'), hasLength(2));
      expect(wallet.signedMessages, hasLength(2));
    });

    testWidgets('422: shows the validation message and saves no session', (tester) async {
      faulty.faults['/auth/verify'] = FaultyBackend.error(422, 'invalid_request', 'publicKey is not valid');
      await open(tester);

      await tap(tester, continueWithNear);
      await pumpUntil(tester, find.text('publicKey is not valid'));
      expect(hasSession(store), isFalse);
      expect(find.text('Verify your identity'), findsNothing);
    });

    testWidgets(
      'the testnet faucet failing (the backend only logs it) still signs in; every quote then says to try again '
      'and nothing is signed',
      (tester) async {
        // The faucet runs after sign-in and its failure is only logged, so the account never appears on NEAR.
        backend.nearAccountPending = 1000;
        final wallet = await open(tester);

        await tap(tester, continueWithNear);
        await pumpUntilHome(tester);
        expect(hasSession(store), isTrue);

        await tap(tester, 'Scan & pay');
        await pumpUntil(tester, find.byKey(const Key('qr-text')));
        await tester.enterText(find.byKey(const Key('qr-text')), qr250);
        await tap(tester, 'Continue');
        const settingUp = 'Your testnet account is still being set up. Try again in a few seconds.';
        await pumpUntil(tester, find.text(settingUp));
        await tap(tester, 'Try again');
        await tester.pump(const Duration(seconds: 1));
        await pumpUntil(tester, find.text(settingUp));

        expect(faulty.calls.where((p) => p == '/quotes'), hasLength(2));
        expect(wallet.signedPayments, isEmpty);
        expect(paths(backend, '/payments'), isEmpty);
        expect(hasSession(store), isTrue);
      },
    );
  });

  group('a slow first sign-in', () {
    testWidgets('keeps the button busy, ignores a second tap, and signs in exactly once', (tester) async {
      final release = Completer<void>();
      faulty.faults['/auth/verify'] = (options) async {
        await release.future;
        return faulty.passThrough(options);
      };
      final wallet = await open(tester);

      await tap(tester, continueWithNear);
      await tester.pump(const Duration(milliseconds: 50));
      expect(
        find.descendant(of: find.byType(FilledButton), matching: find.byType(CircularProgressIndicator)),
        findsOne,
      );
      expect(nearButton(tester).onPressed, isNull);
      await tester.tap(find.byType(FilledButton).last, warnIfMissed: false);
      // 25 seconds on (the first sign-in creates the testnet account): still waiting, no error.
      await tester.pump(const Duration(seconds: 25));
      expect(find.byIcon(Icons.error_outline), findsNothing);

      release.complete();
      await pumpUntil(tester, find.text('Scan & pay'));
      expect(faulty.calls.where((p) => p == '/auth/nonce'), hasLength(1));
      expect(faulty.calls.where((p) => p == '/auth/verify'), hasLength(1));
      expect(wallet.signAttempts, 1);
    });

    testWidgets('timing out near 30 s shows the connection message and saves no session', (tester) async {
      faulty.faults['/auth/verify'] = (options) async {
        await Future<void>.delayed(const Duration(seconds: 29));
        throw DioException(requestOptions: options, type: DioExceptionType.receiveTimeout);
      };
      await open(tester);

      await tap(tester, continueWithNear);
      await tester.pump(const Duration(seconds: 28));
      expect(find.byType(CircularProgressIndicator), findsOneWidget);
      await tester.pump(const Duration(seconds: 2));
      await pumpUntil(tester, find.text(offlineMessage));
      expect(hasSession(store), isFalse);
      expect(nearButton(tester).onPressed, isNotNull);
    });
  });

  group('the wallet fails', () {
    testWidgets('making or loading the key throws: shows an error and asks the backend for nothing', (tester) async {
      final wallet = FailingNearWallet(store: store, connectError: StateError('keystore unavailable'));
      await start(tester, authApp(faulty, store, wallet));
      await pumpUntil(tester, find.text(continueWithNear));

      await tap(tester, continueWithNear);
      await pumpUntil(tester, find.text(genericMessage));
      expect(faulty.calls, isEmpty);
      expect(hasSession(store), isFalse);

      wallet.connectError = null;
      await tap(tester, continueWithNear);
      await pumpUntil(tester, find.text('Scan & pay'));
    });

    testWidgets('no screen lock (release build): says how to fix it', (tester) async {
      final wallet = FailingNearWallet(store: store, connectError: FingerprintGate.unavailable);
      await start(tester, authApp(faulty, store, wallet));
      await pumpUntil(tester, find.text(continueWithNear));

      await tap(tester, continueWithNear);
      await pumpUntil(tester, find.textContaining('Set up a screen lock'));
      expect(faulty.calls, isEmpty);
    });

    testWidgets('signing throws: nothing is sent to verify and no session is saved', (tester) async {
      final wallet = await open(tester)
        ..signError = StateError('secure element busy');

      await tap(tester, continueWithNear);
      await pumpUntil(tester, find.text(genericMessage));
      expect(faulty.calls, ['/auth/nonce']);
      expect(hasSession(store), isFalse);

      wallet.signError = null;
      await tap(tester, continueWithNear);
      await pumpUntil(tester, find.text('Scan & pay'));
    });

    testWidgets('backing out of the fingerprint prompt shows no error and nothing is sent', (tester) async {
      final wallet = await open(tester)
        ..signError = const AppException('biometric_cancelled', 'Cancelled');

      await tap(tester, continueWithNear);
      await tester.pump(const Duration(milliseconds: 500));
      expect(find.byIcon(Icons.error_outline), findsNothing);
      expect(find.text('Cancelled'), findsNothing);
      expect(paths(backend, '/auth/verify'), isEmpty);
      expect(nearButton(tester).onPressed, isNotNull);
      expect(wallet.signAttempts, 1);
    });
  });

  group('the session ends', () {
    testWidgets('a 401 mid-session returns to sign-in and forgets the token, but keeps the NEAR key', (tester) async {
      await open(tester);
      await tap(tester, continueWithNear);
      await pumpUntilHome(tester);
      final account = (backend.requests.firstWhere((r) => r.path == '/auth/nonce').body as Map)['address'];

      // The token is revoked: every signed-in call now answers 401. Scanning a QR asks for a quote.
      faulty.everything = FaultyBackend.error(401, 'unauthorized', 'Token expired');
      await tap(tester, 'Scan & pay');
      await pumpUntil(tester, find.byKey(const Key('qr-text')));
      await tester.enterText(find.byKey(const Key('qr-text')), qr250);
      await tap(tester, 'Continue');
      await pumpUntilOnly(tester, find.text(continueWithNear), find.byKey(const Key('qr-text')));
      // The payment screens finish sliding away.
      await tester.pump(const Duration(seconds: 1));
      expect(faulty.calls, contains('/quotes'));
      expect(hasSession(store), isFalse);
      expect(store.values.containsKey(NearWalletService.storageKey), isTrue);
      expect(find.text('Token expired'), findsNothing);

      // Signing in again gives the same NEAR account.
      faulty.everything = null;
      await tap(tester, continueWithNear);
      await pumpUntilHome(tester);
      final nonces = backend.requests.where((r) => r.path == '/auth/nonce').map((r) => (r.body as Map)['address']);
      expect(nonces, [account, account]);
    });

    testWidgets('a token revoked while the app was closed: the restart goes to sign-in', (tester) async {
      store.values[SessionStore.storageKey] = Session(
        token: 'revoked-token',
        expiresAt: DateTime.now().add(const Duration(days: 1)),
        userId: 'user_1',
        walletAddress: nearTestAccount,
      ).toJson();
      faulty.faults['/kyc/status'] = FaultyBackend.error(401, 'unauthorized', 'Token revoked');
      await start(tester, authApp(faulty, store, FailingNearWallet(store: store)));

      await pumpUntil(tester, find.text(continueWithNear));
      expect(hasSession(store), isFalse);
      expect(faulty.calls, contains('/kyc/status'));
    });

    testWidgets('a saved session for another NEAR account is dropped at restart', (tester) async {
      store.values[SessionStore.storageKey] = Session(
        token: 'test-token',
        expiresAt: DateTime.now().add(const Duration(days: 1)),
        userId: 'user_2',
        walletAddress: 'ab' * 32,
      ).toJson();
      await start(tester, authApp(faulty, store, FailingNearWallet(store: store)));

      await pumpUntil(tester, find.text(continueWithNear));
      expect(hasSession(store), isFalse);
      expect(faulty.calls, isEmpty);
    });

    testWidgets('an unreadable saved session goes to sign-in and is forgotten', (tester) async {
      store.values[SessionStore.storageKey] = '{"token": 42';
      await start(tester, authApp(faulty, store, FailingNearWallet(store: store)));

      await pumpUntil(tester, find.text(continueWithNear));
      expect(hasSession(store), isFalse);
    });

    testWidgets(
      'signing out forgets the session, keeps the NEAR key and the card key; signing in again skips the card step',
      (tester) async {
        await open(tester, onboarding: true);
        await tap(tester, continueWithNear);
        await pumpUntil(tester, find.text('Register card'));
        await tap(tester, 'Register card');
        await pumpUntil(tester, find.text('Use demo card'));
        await tester.pump(const Duration(milliseconds: 500));
        await tap(tester, 'Use demo card');
        await pumpUntil(tester, find.text(cardRegisteredMessage));
        await tap(tester, 'Continue');
        await pumpUntilHome(tester);
        // Let the "Card registered" snack bar time out: it sits over the sign-in button.
        await tester.pump(const Duration(seconds: 5));
        await tester.pump(const Duration(seconds: 1));

        await signOutFromHome(tester);
        expect(hasSession(store), isFalse);
        expect(store.values.containsKey(NearWalletService.storageKey), isTrue);
        // The card key belongs to this phone, not to the session.
        expect(store.values.containsKey(CardKeyStore.hashKey), isTrue);

        await tap(tester, continueWithNear);
        await pumpUntilHome(tester);
        await tester.pump(const Duration(milliseconds: 500));
        expect(find.text('Register card'), findsNothing);
        expect(find.text('Skip'), findsNothing);
        final nonces = backend.requests.where((r) => r.path == '/auth/nonce').map((r) => (r.body as Map)['address']);
        expect(nonces.toSet(), hasLength(1));
      },
    );

    testWidgets('skipping the card step, signing out and in again does not offer it again', (tester) async {
      await open(tester, onboarding: true);
      await tap(tester, continueWithNear);
      await pumpUntil(tester, find.text('Skip'));
      await tap(tester, 'Skip');
      await pumpUntilHome(tester);
      await tester.pump(const Duration(seconds: 1));

      await signOutFromHome(tester);
      await tap(tester, continueWithNear);
      await pumpUntilHome(tester);
      await tester.pump(const Duration(milliseconds: 500));
      expect(find.text('Skip'), findsNothing);
      expect(store.values.containsKey(CardKeyStore.hashKey), isFalse);
    });
  });

  group('identity verification', () {
    testWidgets('refused again on retry: stays on verification, never Home', (tester) async {
      backend.kycStatus = 'REJECTED';
      faulty.faults['/kyc/start'] = (options) async => FaultyBackend.json(200, {
        'status': 'REJECTED',
        'tier': 0,
        'limits': {'perPayment': '0', 'perDay': '0'},
        'session': null,
      });
      await open(tester);
      await tap(tester, continueWithNear);
      await pumpUntil(tester, find.text(rejectedMessage));
      expect(find.text('Scan & pay'), findsNothing);

      await tap(tester, 'Try again');
      await tester.pump(const Duration(seconds: 1));
      expect(faulty.calls.where((p) => p == '/kyc/start'), hasLength(1));
      expect(find.text(rejectedMessage), findsOneWidget);
      expect(find.text('Scan & pay'), findsNothing);
      expect(hasSession(store), isTrue);
    });

    testWidgets('refused, then approved on retry: opens Home', (tester) async {
      backend.kycStatus = 'REJECTED';
      await open(tester);
      await tap(tester, continueWithNear);
      await pumpUntil(tester, find.text(rejectedMessage));

      await tap(tester, 'Try again');
      await pumpUntil(tester, find.text('Scan & pay'));
      expect(paths(backend, '/kyc/start'), hasLength(1));
    });

    testWidgets('KYC status failing shows the error with a retry, which then opens Home', (tester) async {
      faulty.faults['/kyc/status'] = FaultyBackend.error(500, 'internal_error', 'KYC provider is not responding');
      await open(tester);
      await tap(tester, continueWithNear);
      await pumpUntil(tester, find.text('KYC provider is not responding'));
      expect(find.text('Verify your identity'), findsOneWidget);

      faulty.faults.clear();
      await tap(tester, 'Try again');
      await pumpUntil(tester, find.text('Scan & pay'));
    });

    testWidgets('signing out from verification returns to sign-in and forgets the session', (tester) async {
      backend.kycStatus = 'NOT_STARTED';
      await open(tester);
      await tap(tester, continueWithNear);
      await pumpUntil(tester, find.text('Verify your identity'));
      expect(hasSession(store), isTrue);

      await tap(tester, 'Sign out');
      await pumpUntil(tester, find.text(continueWithNear));
      expect(hasSession(store), isFalse);
      expect(store.values.containsKey(NearWalletService.storageKey), isTrue);
    });
  });
}
