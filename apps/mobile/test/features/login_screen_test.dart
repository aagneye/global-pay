import 'package:dio/dio.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:globalpay/app/app.dart';
import 'package:globalpay/core/config/app_config.dart';
import 'package:globalpay/core/providers.dart';
import 'package:globalpay/core/storage/secure_store.dart';
import 'package:globalpay/data/api/api_client.dart';
import 'package:globalpay/data/session_store.dart';
import 'package:globalpay/domain/models/session.dart';
import 'package:globalpay/features/scan/scan_screen.dart';
import 'package:globalpay/services/push/push_service.dart';
import 'package:globalpay/services/wallet/privy_wallet_service.dart';
import 'package:globalpay/services/wallet/wallet_switch.dart';

import '../support/fake_backend.dart';
import '../support/fake_fingerprint.dart';
import '../support/fake_privy.dart';
import '../support/fake_tap.dart';

const config = AppConfig(apiBaseUrl: 'http://backend.test', chainId: 31337);
const email = 'somchai@example.com';
const notConfigured = "Sign-in isn't set up in this build of GlobalPay.";

/// The app with a fake backend. [privy] is the fake Privy SDK, or null for a build without Privy IDs;
/// [debug] stands for kDebugMode (whether the dev wallet is offered).
Widget app(FakeBackend backend, SecureStore store, {FakePrivyClient? privy, required bool debug}) {
  return ProviderScope(
    overrides: [
      appConfigProvider.overrideWithValue(config),
      secureStoreProvider.overrideWithValue(store),
      privyWalletProvider.overrideWithValue(privy == null ? null : PrivyWalletService(privy, gate: FakeGate())),
      devWalletEnabledProvider.overrideWithValue(debug),
      keyVaultProvider.overrideWithValue(null),
      apiClientProvider.overrideWith((ref) {
        final sessions = ref.watch(sessionStoreProvider);
        return ApiClient(config, token: () => sessions.current?.token, dio: Dio()..httpClientAdapter = backend);
      }),
      cameraScannerProvider.overrideWithValue(false),
      tapCardProvider.overrideWithValue(FakeTapCard(supported: false)),
      tapReaderProvider.overrideWithValue(FakeTapReader()),
      pushServiceProvider.overrideWithValue(const NoPushService()),
    ],
    child: const GlobalPayApp(),
  );
}

Future<void> pumpUntil(WidgetTester tester, Finder finder, {int maxFrames = 100}) async {
  for (var i = 0; i < maxFrames; i++) {
    await tester.pump(const Duration(milliseconds: 100));
    if (finder.evaluate().isNotEmpty) return;
  }
  fail('Did not find $finder');
}

Future<void> tap(WidgetTester tester, String label) async {
  await tester.ensureVisible(find.text(label).last);
  await tester.tap(find.text(label).last);
  await tester.pump();
}

/// Lets the async work behind a tap finish.
Future<void> settle(WidgetTester tester) async {
  for (var i = 0; i < 5; i++) {
    await tester.pump(const Duration(milliseconds: 100));
  }
}

/// Pumps [app] on a phone-sized screen.
Future<void> start(WidgetTester tester, Widget app) async {
  tester.view.physicalSize = const Size(1080, 2400);
  tester.view.devicePixelRatio = 2.5;
  addTearDown(tester.view.reset);
  await tester.pumpWidget(app);
}

void main() {
  testWidgets('signs up with an email code, then signs in to the backend with the new wallet', (tester) async {
    final backend = FakeBackend();
    final store = MemorySecureStore();
    final privy = FakePrivyClient();

    await start(tester, app(backend, store, privy: privy, debug: true));
    await pumpUntil(tester, find.text('Email me a code'));
    // A debug build still offers the dev wallet, below the email sign-in.
    expect(find.text('Continue with dev wallet'), findsOneWidget);

    await tester.enterText(find.byKey(const Key('email')), 'somchai');
    await tap(tester, 'Email me a code');
    await settle(tester);
    expect(find.text('Enter a valid email address'), findsOneWidget);
    expect(privy.codesSentTo, isEmpty);

    await tester.enterText(find.byKey(const Key('email')), email);
    await tap(tester, 'Email me a code');
    await pumpUntil(tester, find.byKey(const Key('email-code')));
    expect(privy.codesSentTo, [email]);
    expect(find.text('Enter the code we sent to'), findsOneWidget);
    expect(find.text(email), findsOneWidget);

    await tester.enterText(find.byKey(const Key('email-code')), '000000');
    await tap(tester, 'Sign in');
    await settle(tester);
    expect(find.text("That code didn't work. Check the email, or send a new code."), findsOneWidget);

    await tester.enterText(find.byKey(const Key('email-code')), privy.validCode);
    await tap(tester, 'Sign in');
    await pumpUntil(tester, find.text('Verify your identity'));

    // The embedded wallet was created, signed the backend's message, and is remembered for restarts.
    expect(privy.walletsCreated, 1);
    final nonce = backend.requests.firstWhere((r) => r.path == '/auth/nonce');
    expect((nonce.body as Map)['address'], privy.walletAddress);
    final verify = backend.requests.firstWhere((r) => r.path == '/auth/verify');
    expect((verify.body as Map)['signature'], privy.signature);
    expect(privy.signed.single.$1, 'personal_sign');
    expect(store.values[WalletSwitch.kindKey], 'embedded');
    expect(Session.fromJson(store.values[SessionStore.storageKey]!).walletAddress, privy.walletAddress);
  });

  testWidgets('can change the email or ask for a new code', (tester) async {
    final privy = FakePrivyClient();
    await start(tester, app(FakeBackend(), MemorySecureStore(), privy: privy, debug: true));
    await pumpUntil(tester, find.byKey(const Key('email')));

    await tester.enterText(find.byKey(const Key('email')), email);
    await tap(tester, 'Email me a code');
    await pumpUntil(tester, find.text('Send a new code'));
    await tap(tester, 'Send a new code');
    await settle(tester);
    expect(privy.codesSentTo, [email, email]);

    await tap(tester, 'Use a different email');
    await pumpUntil(tester, find.byKey(const Key('email')));
    expect(find.byKey(const Key('email-code')), findsNothing);
  });

  testWidgets('a release build with Privy offers only the email sign-in', (tester) async {
    await start(tester, app(FakeBackend(), MemorySecureStore(), privy: FakePrivyClient(), debug: false));
    await pumpUntil(tester, find.text('Email me a code'));

    expect(find.byKey(const Key('email')), findsOneWidget);
    expect(find.text('Continue with dev wallet'), findsNothing);
    expect(find.text(notConfigured), findsNothing);
  });

  testWidgets('a release build without Privy says sign-in is not set up, with no dev wallet', (tester) async {
    await start(tester, app(FakeBackend(), MemorySecureStore(), debug: false));
    await pumpUntil(tester, find.text(notConfigured));

    expect(find.text('Continue with dev wallet'), findsNothing);
    expect(find.byKey(const Key('email')), findsNothing);
    expect(find.byType(FilledButton), findsNothing);
  });

  testWidgets('a debug build without Privy offers the dev wallet', (tester) async {
    await start(tester, app(FakeBackend(), MemorySecureStore(), debug: true));
    await pumpUntil(tester, find.text('Continue with dev wallet'));

    expect(find.byKey(const Key('email')), findsNothing);
    expect(find.text(notConfigured), findsNothing);
  });

  group('restoring a saved session', () {
    final saved = Session(
      token: 'test-token',
      expiresAt: DateTime.now().add(const Duration(days: 1)),
      userId: 'user_1',
      walletAddress: FakePrivyClient().walletAddress,
    );

    MemorySecureStore signedIn() => MemorySecureStore()
      ..values[SessionStore.storageKey] = saved.toJson()
      ..values[WalletSwitch.kindKey] = 'embedded';

    testWidgets('reconnects the embedded wallet without a code', (tester) async {
      final privy = FakePrivyClient(authenticated: true, hasWallet: true);
      await start(tester, app(FakeBackend(), signedIn(), privy: privy, debug: false));

      await pumpUntil(tester, find.text('Verify your identity'));
      expect(privy.codesSentTo, isEmpty);
    });

    testWidgets("signs out when Privy's own session has ended", (tester) async {
      final store = signedIn();
      await start(tester, app(FakeBackend(), store, privy: FakePrivyClient(), debug: false));

      await pumpUntil(tester, find.text('Email me a code'));
      expect(store.values.containsKey(SessionStore.storageKey), isFalse);
    });
  });
}
