import 'dart:convert';

import 'package:dio/dio.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:globalpay/app/app.dart';
import 'package:globalpay/core/config/app_config.dart';
import 'package:globalpay/core/providers.dart';
import 'package:globalpay/core/storage/secure_store.dart';
import 'package:globalpay/data/api/api_client.dart';
import 'package:globalpay/features/scan/scan_screen.dart';
import 'package:globalpay/services/push/push_service.dart';

import 'support/fake_backend.dart';
import 'support/fake_tap.dart';
import 'support/near_vectors.dart';
import 'support/spy_near_wallet.dart';

/// The app on the NEAR rail, with the test contracts the fake backend uses.
const nearConfig = AppConfig(
  apiBaseUrl: 'http://backend.test',
  chainId: 31337,
  settlementRail: SettlementRail.near,
  nearUsdcContract: FakeBackend.nearUsdc,
  nearSettlementContract: FakeBackend.nearSettlement,
);

/// [wallet] is the NEAR wallet, with an in-memory store. Vault off, push off, no NFC.
Widget nearApp(FakeBackend backend, SecureStore store, SpyNearWallet wallet, {AppConfig config = nearConfig}) {
  return ProviderScope(
    overrides: [
      appConfigProvider.overrideWithValue(config),
      secureStoreProvider.overrideWithValue(store),
      nearWalletProvider.overrideWithValue(wallet),
      keyVaultProvider.overrideWithValue(null),
      apiClientProvider.overrideWith((ref) {
        final sessions = ref.watch(sessionStoreProvider);
        return ApiClient(config, token: () => sessions.current?.token, dio: Dio()..httpClientAdapter = backend);
      }),
      cameraScannerProvider.overrideWithValue(false),
      tapCardProvider.overrideWithValue(FakeTapCard()),
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

Future<void> start(WidgetTester tester, Widget app) async {
  tester.view.physicalSize = const Size(1080, 2400);
  tester.view.devicePixelRatio = 2.5;
  addTearDown(tester.view.reset);
  await tester.pumpWidget(app);
}

const continueWithNear = 'Continue with NEAR testnet wallet';

void main() {
  testWidgets('signs in with the NEAR testnet wallet (NEP-413), and stays signed in across restarts', (tester) async {
    final backend = FakeBackend(near: true)..kycStatus = 'APPROVED';
    final store = MemorySecureStore();
    final wallet = SpyNearWallet(store: store, importSeed: nearTestSeed);

    await start(tester, nearApp(backend, store, wallet));
    await pumpUntil(tester, find.text(continueWithNear));
    // The NEAR rail offers only the NEAR wallet.
    expect(find.text('TESTNET'), findsOneWidget);
    expect(find.text('Continue with dev wallet'), findsNothing);
    expect(find.byKey(const Key('email')), findsNothing);

    await tap(tester, continueWithNear);
    await pumpUntil(tester, find.text('Scan & pay'));
    final nonce = backend.requests.firstWhere((r) => r.path == '/auth/nonce').body as Map;
    expect(nonce['address'], nearTestAccount);
    final verify = backend.requests.firstWhere((r) => r.path == '/auth/verify').body as Map;
    expect(verify['publicKey'], nearTestPublicKey);
    expect(base64.decode(verify['signature'] as String), hasLength(64));
    expect(wallet.signedMessages, [verify['message']]);
    // The fake backend checked the signature over the NEP-413 payload, as the real one does.
    expect(backend.nearPublicKey, nearTestPublicKey);
    expect(backend.requests.last.auth, 'Bearer test-token');

    // A fresh app over the same storage restores the session with the same NEAR account.
    await tester.pumpWidget(const SizedBox());
    await tester.pumpWidget(nearApp(backend, store, SpyNearWallet(store: store)));
    await pumpUntil(tester, find.text('Scan & pay'));
    expect(backend.requests.where((r) => r.path == '/auth/verify'), hasLength(1));
  });

  testWidgets('shows why sign-in failed when the backend rejects the signature', (tester) async {
    final backend = FakeBackend(near: true);
    final store = MemorySecureStore();
    // Signs in for another recipient than the backend expects, so the backend can't verify it.
    const wrongRecipient = AppConfig(
      apiBaseUrl: 'http://backend.test',
      chainId: 31337,
      settlementRail: SettlementRail.near,
      nearSignInRecipient: 'evil.example',
    );
    await start(tester, nearApp(backend, store, SpyNearWallet(store: store), config: wrongRecipient));
    await pumpUntil(tester, find.text(continueWithNear));
    await tap(tester, continueWithNear);
    await pumpUntil(tester, find.text('Signature does not match'));
    expect(find.text('Scan & pay'), findsNothing);
  });
}
