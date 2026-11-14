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
import 'package:globalpay/services/wallet/dev_wallet_service.dart';

import 'support/fake_backend.dart';

/// anvil account #4, a public test key.
const testKey = '0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a';

/// A dynamic PromptPay QR for 250.00 THB at GLOBALPAY TEST CAFE (from packages/fixtures).
const qr250 =
    '00020101021230600016A00000067701011201150999999999999010207INV00010306TABLE753037645406250.005802TH'
    '5919GLOBALPAY TEST CAFE6007BANGKOK6304E9FD';

const config = AppConfig(apiBaseUrl: 'http://backend.test', chainId: 31337);

/// [launched] collects the checkout pages the app opens (no browser in tests).
Widget app(FakeBackend backend, SecureStore store, {List<Uri>? launched}) {
  return ProviderScope(
    overrides: [
      appConfigProvider.overrideWithValue(config),
      secureStoreProvider.overrideWithValue(store),
      walletServiceProvider.overrideWith((ref) => DevWalletService(store: store, importKey: testKey)),
      apiClientProvider.overrideWith((ref) {
        final sessions = ref.watch(sessionStoreProvider);
        return ApiClient(config, token: () => sessions.current?.token, dio: Dio()..httpClientAdapter = backend);
      }),
      cameraScannerProvider.overrideWithValue(false),
      checkoutLauncherProvider.overrideWithValue((url) async {
        launched?.add(url);
        return true;
      }),
    ],
    child: const GlobalPayApp(),
  );
}

/// Pumps frames until [finder] matches (spinners and timers mean the app never "settles").
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

void main() {
  testWidgets('signs in, verifies, pays a PromptPay QR and follows it to SETTLED', (tester) async {
    tester.view.physicalSize = const Size(1080, 2400);
    tester.view.devicePixelRatio = 2.5;
    addTearDown(tester.view.reset);
    final backend = FakeBackend();
    final store = MemorySecureStore();

    await tester.pumpWidget(app(backend, store));
    await pumpUntil(tester, find.text('Continue with dev wallet'));

    // Sign in: the wallet signs the backend's message, and requests carry the token afterwards.
    await tap(tester, 'Continue with dev wallet');
    await pumpUntil(tester, find.text('Verify your identity'));
    final verify = backend.requests.firstWhere((r) => r.path == '/auth/verify');
    expect((verify.body as Map)['signature'], matches(RegExp(r'^0x[0-9a-f]{130}$')));
    expect(store.values[DevWalletService.storageKey], testKey);

    // KYC: the mock approves, and the router opens home.
    await tap(tester, 'Continue');
    await pumpUntil(tester, find.byKey(const Key('balance')));
    expect(find.text('10000.000000 USDC'), findsOneWidget);
    expect(backend.requests.last.auth, 'Bearer test-token');

    // Scan (pasted text), then confirm the quote.
    await tap(tester, 'Scan & pay');
    await pumpUntil(tester, find.byKey(const Key('qr-text')));
    await tester.enterText(find.byKey(const Key('qr-text')), 'not a qr');
    await tap(tester, 'Continue');
    expect(find.text('QR has no checksum'), findsOneWidget);

    await tester.enterText(find.byKey(const Key('qr-text')), qr250);
    await tap(tester, 'Continue');
    await pumpUntil(tester, find.text('Pay 7.477454 USDC'));
    expect(find.text('GLOBALPAY TEST CAFE'), findsOneWidget);
    expect(find.text('33.77 THB/USDC'), findsOneWidget);
    expect(find.text('0.074034 USDC'), findsOneWidget);

    // Pay: the wallet signs the USDC authorisation, then the status screen polls until final.
    await tap(tester, 'Pay 7.477454 USDC');
    await pumpUntil(tester, find.text('Payment status'));
    final submitted = backend.requests.firstWhere((r) => r.path == '/payments').body as Map;
    expect(submitted['quoteId'], FakeBackend.quoteId);
    expect(submitted['validAfter'], '0');
    expect(submitted['signature'], matches(RegExp(r'^0x[0-9a-f]{130}$')));

    await pumpUntil(tester, find.byKey(const Key('status-headline')), maxFrames: 50);
    await pumpUntil(tester, find.text('The merchant received ฿250.00.'), maxFrames: 50);
    expect(find.text('Merchant paid'), findsWidgets);
    expect(find.text(FakeBackend.bankReference), findsOneWidget);
    expect(find.text('Settlement transaction'), findsOneWidget);

    await tap(tester, 'Done');
    await pumpUntil(tester, find.text('Recent payments'));
    await pumpUntil(tester, find.text('GLOBALPAY TEST CAFE'));
  });

  testWidgets('shows a refund when the merchant payout fails', (tester) async {
    tester.view.physicalSize = const Size(1080, 2400);
    tester.view.devicePixelRatio = 2.5;
    addTearDown(tester.view.reset);
    final backend = FakeBackend(finalStatus: 'REFUNDED')..kycStatus = 'APPROVED';
    final store = MemorySecureStore();

    await tester.pumpWidget(app(backend, store));
    await pumpUntil(tester, find.text('Continue with dev wallet'));
    await tap(tester, 'Continue with dev wallet');
    await pumpUntil(tester, find.text('Scan & pay'));

    await tap(tester, 'Scan & pay');
    await pumpUntil(tester, find.byKey(const Key('qr-text')));
    await tester.enterText(find.byKey(const Key('qr-text')), qr250);
    await tap(tester, 'Continue');
    await pumpUntil(tester, find.text('Pay 7.477454 USDC'));
    await tap(tester, 'Pay 7.477454 USDC');

    await pumpUntil(tester, find.text('Refunded'), maxFrames: 50);
    expect(find.text('The merchant payout failed, so your USDC was returned.'), findsOneWidget);
    expect(find.text('Simulated payout failure (PAYOUT_FAILURE_RATE)'), findsOneWidget);
    expect(find.text('USDC refunded'), findsOneWidget);
  });

  testWidgets('shows "Needs review", never "paid", while the payout outcome is unclear', (tester) async {
    tester.view.physicalSize = const Size(1080, 2400);
    tester.view.devicePixelRatio = 2.5;
    addTearDown(tester.view.reset);
    final backend = FakeBackend(finalStatus: 'PAYOUT_PENDING', payoutStatus: 'UNKNOWN')..kycStatus = 'APPROVED';
    final store = MemorySecureStore();

    await tester.pumpWidget(app(backend, store));
    await pumpUntil(tester, find.text('Continue with dev wallet'));
    await tap(tester, 'Continue with dev wallet');
    await pumpUntil(tester, find.text('Scan & pay'));

    await tap(tester, 'Scan & pay');
    await pumpUntil(tester, find.byKey(const Key('qr-text')));
    await tester.enterText(find.byKey(const Key('qr-text')), qr250);
    await tap(tester, 'Continue');
    await pumpUntil(tester, find.text('Pay 7.477454 USDC'));
    await tap(tester, 'Pay 7.477454 USDC');

    await pumpUntil(tester, find.text('Needs review'), maxFrames: 50);
    expect(find.textContaining("You won't pay twice"), findsOneWidget);
    expect(tester.widget<Text>(find.byKey(const Key('status-headline'))).data, 'Needs review');
    expect(find.text('Bank reference'), findsNothing);
    expect(find.text('Done'), findsNothing);
  });

  testWidgets('adds money: opens the checkout, then shows the USDC once it arrives', (tester) async {
    tester.view.physicalSize = const Size(1080, 2400);
    tester.view.devicePixelRatio = 2.5;
    addTearDown(tester.view.reset);
    final backend = FakeBackend()..kycStatus = 'APPROVED';
    final launched = <Uri>[];

    await tester.pumpWidget(app(backend, MemorySecureStore(), launched: launched));
    await pumpUntil(tester, find.text('Continue with dev wallet'));
    await tap(tester, 'Continue with dev wallet');
    await pumpUntil(tester, find.text('Add money'));
    await tap(tester, 'Add money');
    await pumpUntil(tester, find.byKey(const Key('add-money-amount')));

    await tester.enterText(find.byKey(const Key('add-money-amount')), '500');
    await tap(tester, 'Continue to payment');
    expect(find.text('Enter at least ฿800'), findsOneWidget);

    await tester.enterText(find.byKey(const Key('add-money-amount')), '800');
    await tap(tester, 'Continue to payment');
    await pumpUntil(tester, find.text('Waiting for your payment'));
    expect(launched, [Uri.parse('http://backend.test/onramp/simulator/order_1')]);
    expect((backend.requests.firstWhere((r) => r.path == '/onramp/orders').body as Map)['fiatAmountMinor'], '80000');
    expect(find.text('Open checkout again'), findsOneWidget);

    await pumpUntil(tester, find.text('Added 24.615384 USDC'), maxFrames: 60);
    expect(find.text('The USDC is in your wallet.'), findsOneWidget);
    expect(find.text('Delivery transaction'), findsOneWidget);

    await tap(tester, 'Done');
    await pumpUntil(tester, find.text('History'));
    await tap(tester, 'History');
    await pumpUntil(tester, find.text('Added money'));
    expect(find.text('+24.615384 USDC'), findsOneWidget);
  });

  testWidgets('stays signed in across restarts', (tester) async {
    final backend = FakeBackend()..kycStatus = 'APPROVED';
    final store = MemorySecureStore();

    await tester.pumpWidget(app(backend, store));
    await pumpUntil(tester, find.text('Continue with dev wallet'));
    await tap(tester, 'Continue with dev wallet');
    await pumpUntil(tester, find.text('Scan & pay'));

    // A fresh app over the same storage.
    await tester.pumpWidget(const SizedBox());
    await tester.pumpWidget(app(backend, store));
    await pumpUntil(tester, find.text('Scan & pay'));
    expect(backend.requests.where((r) => r.path == '/auth/verify'), hasLength(1));
  });
}
