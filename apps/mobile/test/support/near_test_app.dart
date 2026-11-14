import 'dart:async';

import 'package:dio/dio.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:go_router/go_router.dart';
import 'package:globalpay/app/app.dart';
import 'package:globalpay/app/router.dart';
import 'package:globalpay/core/config/app_config.dart';
import 'package:globalpay/core/providers.dart';
import 'package:globalpay/core/storage/secure_store.dart';
import 'package:globalpay/data/api/api_client.dart';
import 'package:globalpay/features/scan/scan_screen.dart';
import 'package:globalpay/services/push/push_service.dart';

import 'fake_backend.dart';
import 'fake_card_reader.dart';
import 'fake_tap.dart';
import 'near_vectors.dart';
import 'scripted_backend.dart';
import 'spy_near_wallet.dart';

/// The app on the NEAR rail with the fake backend's test contracts.
const nearTestConfig = AppConfig(
  apiBaseUrl: 'http://backend.test',
  chainId: 31337,
  settlementRail: SettlementRail.near,
  nearUsdcContract: FakeBackend.nearUsdc,
  nearSettlementContract: FakeBackend.nearSettlement,
);

/// A dynamic PromptPay QR for 250.00 THB at GLOBALPAY TEST CAFE (from packages/fixtures).
const promptPay250 =
    '00020101021230600016A00000067701011201150999999999999010207INV00010306TABLE753037645406250.005802TH'
    '5919GLOBALPAY TEST CAFE6007BANGKOK6304E9FD';

const payPromptPay250 = 'Pay 7.477454 USDC';

/// The NEAR app (like near_flow_test's) over any backend [adapter]: no card key, no NFC, no vault, no push.
Widget nearTestApp(HttpClientAdapter adapter, SecureStore store, SpyNearWallet wallet) => ProviderScope(
  overrides: [
    appConfigProvider.overrideWithValue(nearTestConfig),
    cardReaderProvider.overrideWithValue(FakeCardReader()),
    cardKeyOnboardingProvider.overrideWithValue(false),
    secureStoreProvider.overrideWithValue(store),
    nearWalletProvider.overrideWithValue(wallet),
    keyVaultProvider.overrideWithValue(null),
    apiClientProvider.overrideWith((ref) {
      final sessions = ref.watch(sessionStoreProvider);
      return ApiClient(nearTestConfig, token: () => sessions.current?.token, dio: Dio()..httpClientAdapter = adapter);
    }),
    cameraScannerProvider.overrideWithValue(false),
    tapCardProvider.overrideWithValue(FakeTapCard()),
    tapReaderProvider.overrideWithValue(FakeTapReader()),
    pushServiceProvider.overrideWithValue(const NoPushService()),
  ],
  child: const GlobalPayApp(),
);

Future<void> pumpUntilFound(WidgetTester tester, Finder finder, {int maxFrames = 100}) async {
  for (var i = 0; i < maxFrames; i++) {
    await tester.pump(const Duration(milliseconds: 100));
    if (finder.evaluate().isNotEmpty) return;
  }
  fail('Did not find $finder');
}

Future<void> tapText(WidgetTester tester, String label) async {
  await tester.ensureVisible(find.text(label).last);
  await tester.tap(find.text(label).last);
  await tester.pump();
}

/// Signs in with the NEAR test wallet (KYC approved) and waits for Home. [setUp] scripts the backend first.
Future<({ScriptedBackend backend, SpyNearWallet wallet})> signedInOnNear(
  WidgetTester tester, {
  void Function(ScriptedBackend backend)? setUp,
}) async {
  tester.view.physicalSize = const Size(1080, 2400);
  tester.view.devicePixelRatio = 2.5;
  addTearDown(tester.view.reset);
  final backend = ScriptedBackend(FakeBackend(near: true)..kycStatus = 'APPROVED');
  setUp?.call(backend);
  final store = MemorySecureStore();
  final wallet = SpyNearWallet(store: store, importSeed: nearTestSeed);
  await tester.pumpWidget(nearTestApp(backend, store, wallet));
  await pumpUntilFound(tester, find.text('Continue with NEAR testnet wallet'));
  await tapText(tester, 'Continue with NEAR testnet wallet');
  await pumpUntilFound(tester, find.text('Scan & pay'));
  return (backend: backend, wallet: wallet);
}

/// From Home: scans [promptPay250] and waits for its quote's Pay button.
Future<void> quotePromptPay250(WidgetTester tester) async {
  await tapText(tester, 'Scan & pay');
  await pumpUntilFound(tester, find.byKey(const Key('qr-text')));
  await tester.enterText(find.byKey(const Key('qr-text')), promptPay250);
  await tapText(tester, 'Continue');
  await pumpUntilFound(tester, find.text(payPromptPay250));
}

/// Opens payment [paymentId]'s status screen from Home, as a history tile or a finished payment does.
Future<void> openStatus(WidgetTester tester, [String paymentId = FakeBackend.paymentId]) async {
  unawaited(GoRouter.of(tester.element(find.text('Scan & pay'))).push(Routes.status(paymentId)));
  await tester.pump();
}
