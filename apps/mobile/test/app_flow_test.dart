import 'package:dio/dio.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:globalpay/app/app.dart';
import 'package:globalpay/core/config/app_config.dart';
import 'package:globalpay/core/providers.dart';
import 'package:globalpay/core/storage/secure_store.dart';
import 'package:globalpay/data/api/api_client.dart';
import 'package:globalpay/features/p2p/p2p_support.dart';
import 'package:globalpay/features/scan/scan_screen.dart';
import 'package:globalpay/services/wallet/dev_wallet_service.dart';

import 'package:globalpay/services/push/push_service.dart';

import 'support/fake_backend.dart';
import 'support/fake_tap.dart';
import 'support/spy_wallet.dart';

/// anvil account #4, a public test key.
const testKey = '0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a';

/// A dynamic PromptPay QR for 250.00 THB at GLOBALPAY TEST CAFE (from packages/fixtures).
const qr250 =
    '00020101021230600016A00000067701011201150999999999999010207INV00010306TABLE753037645406250.005802TH'
    '5919GLOBALPAY TEST CAFE6007BANGKOK6304E9FD';

const config = AppConfig(apiBaseUrl: 'http://backend.test', chainId: 31337);

/// [launched] collects the checkout pages the app opens (no browser in tests). [card] and [reader]
/// stand in for NFC; push is off, so the apps poll. [wallet] replaces the dev wallet, e.g. with a [SpyWallet].
Widget app(
  FakeBackend backend,
  SecureStore store, {
  List<Uri>? launched,
  FakeTapCard? card,
  FakeTapReader? reader,
  DevWalletService? wallet,
  AppConfig appConfig = config,
}) {
  return ProviderScope(
    overrides: [
      appConfigProvider.overrideWithValue(appConfig),
      secureStoreProvider.overrideWithValue(store),
      walletServiceProvider.overrideWith((ref) => wallet ?? DevWalletService(store: store, importKey: testKey)),
      apiClientProvider.overrideWith((ref) {
        final sessions = ref.watch(sessionStoreProvider);
        return ApiClient(appConfig, token: () => sessions.current?.token, dio: Dio()..httpClientAdapter = backend);
      }),
      cameraScannerProvider.overrideWithValue(false),
      tapCardProvider.overrideWithValue(card ?? FakeTapCard(supported: false)),
      tapReaderProvider.overrideWithValue(reader ?? FakeTapReader()),
      pushServiceProvider.overrideWithValue(const NoPushService()),
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

  testWidgets('backing out of the fingerprint prompt shows no error, and paying again works', (tester) async {
    tester.view.physicalSize = const Size(1080, 2400);
    tester.view.devicePixelRatio = 2.5;
    addTearDown(tester.view.reset);
    final backend = FakeBackend()..kycStatus = 'APPROVED';
    final wallet = SpyWallet(store: MemorySecureStore(), importKey: testKey)..cancelNext = true;

    await tester.pumpWidget(app(backend, MemorySecureStore(), wallet: wallet));
    await pumpUntil(tester, find.text('Continue with dev wallet'));
    await tap(tester, 'Continue with dev wallet');
    await pumpUntil(tester, find.text('Scan & pay'));
    await tap(tester, 'Scan & pay');
    await pumpUntil(tester, find.byKey(const Key('qr-text')));
    await tester.enterText(find.byKey(const Key('qr-text')), qr250);
    await tap(tester, 'Continue');
    await pumpUntil(tester, find.text('Pay 7.477454 USDC'));

    await tap(tester, 'Pay 7.477454 USDC');
    await tester.pump(const Duration(milliseconds: 200));
    expect(find.textContaining('canceled'), findsNothing);
    expect(backend.requests.where((r) => r.path == '/payments'), isEmpty);

    await tap(tester, 'Pay 7.477454 USDC');
    await pumpUntil(tester, find.byKey(const Key('status-headline')), maxFrames: 50);
    expect(wallet.signedTypedData, hasLength(1));
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

  group('refuses to sign what a compromised backend sends', () {
    Future<void> pay(WidgetTester tester, FakeBackend backend, SpyWallet wallet, {AppConfig appConfig = config}) async {
      tester.view.physicalSize = const Size(1080, 2400);
      tester.view.devicePixelRatio = 2.5;
      addTearDown(tester.view.reset);
      await tester.pumpWidget(app(backend, MemorySecureStore(), wallet: wallet, appConfig: appConfig));
      await pumpUntil(tester, find.text('Continue with dev wallet'));
      await tap(tester, 'Continue with dev wallet');
      await pumpUntil(tester, find.text('Scan & pay'));
      await tap(tester, 'Scan & pay');
      await pumpUntil(tester, find.byKey(const Key('qr-text')));
      await tester.enterText(find.byKey(const Key('qr-text')), qr250);
      await tap(tester, 'Continue');
      await pumpUntil(tester, find.text('Pay 7.477454 USDC'));
      await tap(tester, 'Pay 7.477454 USDC');
      await pumpUntil(tester, find.textContaining('Stopped before signing'));
    }

    testWidgets('a quote authorisation for more than the screen shows', (tester) async {
      final backend = FakeBackend()
        ..kycStatus = 'APPROVED'
        ..tamper = (typed) => (typed['message']! as Map)['value'] = '7477454000';
      final wallet = SpyWallet(store: MemorySecureStore(), importKey: testKey);
      await pay(tester, backend, wallet);

      expect(find.textContaining('(the amount)'), findsOneWidget);
      expect(find.textContaining('Nothing was signed'), findsOneWidget);
      expect(wallet.signedTypedData, isEmpty);
      expect(backend.requests.where((r) => r.path == '/payments'), isEmpty);
    });

    testWidgets('a quote authorisation that pays someone other than the settlement contract', (tester) async {
      final backend = FakeBackend()
        ..kycStatus = 'APPROVED'
        ..tamper = (typed) => (typed['message']! as Map)['to'] = '0x000000000000000000000000000000000000dEaD';
      final wallet = SpyWallet(store: MemorySecureStore(), importKey: testKey);
      const withSettlement = AppConfig(
        apiBaseUrl: 'http://backend.test',
        chainId: 31337,
        settlementAddress: '0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512',
      );
      await pay(tester, backend, wallet, appConfig: withSettlement);

      expect(find.textContaining('(the recipient)'), findsOneWidget);
      expect(wallet.signedTypedData, isEmpty);
      expect(backend.requests.where((r) => r.path == '/payments'), isEmpty);
    });
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

  group('tap to pay', () {
    Future<void> signIn(WidgetTester tester, Widget widget) async {
      tester.view.physicalSize = const Size(1080, 2400);
      tester.view.devicePixelRatio = 2.5;
      addTearDown(tester.view.reset);
      await tester.pumpWidget(widget);
      await pumpUntil(tester, find.text('Continue with dev wallet'));
      await tap(tester, 'Continue with dev wallet');
      await pumpUntil(tester, find.text('Pay by tap'));
    }

    testWidgets('receiver: reads the other phone, then sees the payment arrive', (tester) async {
      final backend = FakeBackend()..kycStatus = 'APPROVED';
      final reader = FakeTapReader();
      await signIn(tester, app(backend, MemorySecureStore(), reader: reader));

      await tap(tester, 'Request');
      await pumpUntil(tester, find.byKey(const Key('request-amount')));
      await tester.enterText(find.byKey(const Key('request-amount')), '5');
      await tap(tester, 'Request');
      await pumpUntil(tester, find.text('Hold their phone to the back of yours'));
      expect(find.text('5.000000 USDC'), findsOneWidget);

      // The fake phone answers: its device ID and signature go to the backend.
      await pumpUntil(tester, find.text('Waiting for them to approve'), maxFrames: 40);
      expect(reader.challenges, [FakeBackend.p2pChallenge]);
      expect(
        backend.requests.firstWhere((r) => r.path == '/p2p/requests/request_1/tap').body,
        {'deviceId': 'device_9', 'signature': '0x3044abcd'},
      );

      await pumpUntil(tester, find.text('Received 5.000000 USDC'), maxFrames: 60);
      await tap(tester, 'Done');
      await pumpUntil(tester, find.text('Pay by tap'));
      await tester.pump(const Duration(seconds: 1));

      // History shows it once: as the tap payment, not again as the deposit of its transfer.
      await tap(tester, 'History');
      await pumpUntil(tester, find.text('Received from 0x15d3…6A65'));
      expect(find.text('+5.000000 USDC'), findsOneWidget);
      expect(find.text('Received'), findsNothing);
      expect(backend.requests.where((r) => r.method == 'GET' && r.path == '/p2p/requests'), isNotEmpty);
    });

    testWidgets('sender: answers taps, then approves with the wallet', (tester) async {
      final backend = FakeBackend(p2pRole: 'sender')..kycStatus = 'APPROVED';
      final card = FakeTapCard();
      await signIn(tester, app(backend, MemorySecureStore(), card: card));
      // Signed in: the phone registered its hardware key, and knows its device ID.
      await tester.pump(const Duration(milliseconds: 300));
      expect(card.deviceId, 'device_1');
      expect((backend.requests.firstWhere((r) => r.path == '/devices').body as Map)['publicKey'], startsWith('MFkw'));

      await tap(tester, 'Pay by tap');
      await pumpUntil(tester, find.text('Hold your phone to theirs'));
      await tester.pump(const Duration(milliseconds: 100));
      expect(card.arms, [const Duration(seconds: 60)]);

      // The receiver tapped: the backend now has a request waiting for this phone's owner.
      backend.p2pStatus = 'SENDER_IDENTIFIED';
      await pumpUntil(tester, find.text('Somchai Coffee'), maxFrames: 40);
      await tester.pump(const Duration(seconds: 1)); // the tap screen closes after its transition
      expect(card.disarms, greaterThan(0));
      expect(find.text('Name not verified: check it with them'), findsOneWidget);
      expect(find.text('5.000000 USDC'), findsOneWidget);

      await tap(tester, 'Approve');
      await pumpUntil(tester, find.text('Paid 5.000000 USDC'), maxFrames: 60);
      final approve = backend.requests.firstWhere((r) => r.path == '/p2p/requests/request_1/approve');
      expect((approve.body as Map)['signature'], matches(RegExp(r'^0x[0-9a-f]{130}$')));
      await tap(tester, 'Done');
      await tester.pump(const Duration(seconds: 1));

      await tap(tester, 'History');
      await pumpUntil(tester, find.text('Paid Somchai Coffee'));
      expect(find.text('5.000000 USDC'), findsOneWidget);
    });

    testWidgets('sender: refuses to sign a transfer to someone the screen does not show', (tester) async {
      // A compromised backend: the request shows Somchai Coffee, the transfer pays someone else.
      final backend = FakeBackend(p2pRole: 'sender')
        ..kycStatus = 'APPROVED'
        ..p2pStatus = 'SENDER_IDENTIFIED'
        ..tamper = (typed) => (typed['message']! as Map)['to'] = '0x000000000000000000000000000000000000dEaD';
      final store = MemorySecureStore();
      final wallet = SpyWallet(store: store, importKey: testKey);
      await signIn(tester, app(backend, store, wallet: wallet));
      await tap(tester, 'Pay by tap');
      await pumpUntil(tester, find.text('Somchai Coffee'), maxFrames: 40);
      await tester.pump(const Duration(seconds: 1));

      await tap(tester, 'Approve');
      await pumpUntil(tester, find.textContaining('Stopped before signing'));
      expect(find.textContaining('(the recipient)'), findsOneWidget);
      expect(wallet.signedTypedData, isEmpty);
      expect(backend.requests.where((r) => r.path == '/p2p/requests/request_1/approve'), isEmpty);
      expect(find.text('Approve'), findsOneWidget);
    });

    testWidgets("sender: scans the receiver's code instead of tapping", (tester) async {
      final backend = FakeBackend(p2pRole: 'sender')..kycStatus = 'APPROVED';
      await signIn(tester, app(backend, MemorySecureStore()));
      await tap(tester, 'Pay by tap');
      await pumpUntil(tester, find.text("This phone can't pay by tap"));
      await tap(tester, 'Scan their code instead');
      await pumpUntil(tester, find.byKey(const Key('qr-text')));
      await tester.enterText(find.byKey(const Key('qr-text')), 'globalpay://pay?r=request_1&c=${FakeBackend.p2pChallenge}');
      await tap(tester, 'Continue');
      await pumpUntil(tester, find.text('Somchai Coffee'), maxFrames: 40);
      expect(backend.requests.firstWhere((r) => r.path == '/p2p/requests/request_1/claim').body, {'challenge': FakeBackend.p2pChallenge});

      await tap(tester, 'Decline');
      await pumpUntil(tester, find.text('Declined. No money moved.'));
    });

    Future<void> openThisPhone(WidgetTester tester) async {
      await tester.tap(find.byType(PopupMenuButton<String>));
      await pumpUntil(tester, find.text('This phone'));
      await tester.pump(const Duration(milliseconds: 500)); // the menu opening
      await tap(tester, 'This phone');
    }

    testWidgets('turns tap to pay off for this phone, and back on', (tester) async {
      final backend = FakeBackend(p2pRole: 'sender')..kycStatus = 'APPROVED';
      final card = FakeTapCard();
      final store = MemorySecureStore();
      await signIn(tester, app(backend, store, card: card));
      await tester.pump(const Duration(milliseconds: 300));
      expect(card.deviceId, 'device_1');
      int registrations() => backend.requests.where((r) => r.method == 'POST' && r.path == '/devices').length;
      final revocations = backend.requests.where((r) => r.method == 'DELETE');

      // It asks first: cancelling changes nothing.
      await openThisPhone(tester);
      await pumpUntil(tester, find.text('Turn off tap to pay?'));
      await tap(tester, 'Cancel');
      await tester.pump(const Duration(milliseconds: 300));
      expect(revocations, isEmpty);

      await openThisPhone(tester);
      await pumpUntil(tester, find.text('Turn off tap to pay?'));
      await tap(tester, 'Turn off');
      await pumpUntil(tester, find.text('Tap to pay is off for this phone'));
      expect(revocations.map((r) => r.path), ['/devices/device_1']);
      expect(card.disarms, greaterThan(0));
      expect(store.values[tapToPayOffKey], isNotNull);

      // "Pay by tap" says so, and doesn't arm the phone.
      await tap(tester, 'Pay by tap');
      await pumpUntil(tester, find.textContaining('Turn it back on from "This phone"'));
      expect(tester.widget<Text>(find.byKey(const Key('tap-headline'))).data, 'Tap to pay is off for this phone');
      expect(card.arms, isEmpty);
      await tester.pageBack();
      await pumpUntil(tester, find.text('Scan & pay'));

      // Off lasts across a restart: the phone isn't registered again.
      final before = registrations();
      await tester.pumpWidget(const SizedBox());
      await tester.pumpWidget(app(backend, store, card: card));
      await pumpUntil(tester, find.text('Pay by tap'));
      await tester.pump(const Duration(milliseconds: 300));
      expect(registrations(), before);

      await openThisPhone(tester);
      await pumpUntil(tester, find.text('Tap to pay is off'));
      await tap(tester, 'Turn on');
      await pumpUntil(tester, find.text('Tap to pay is on for this phone'));
      expect(registrations(), before + 1);
      expect(store.values[tapToPayOffKey], isNull);
    });

    testWidgets("says when this phone can't pay by tap", (tester) async {
      final backend = FakeBackend()..kycStatus = 'APPROVED';
      await signIn(tester, app(backend, MemorySecureStore()));
      await openThisPhone(tester);
      await pumpUntil(tester, find.textContaining("This phone can't pay by tap"));
      await tap(tester, 'OK');
      await tester.pump(const Duration(milliseconds: 300));
      expect(backend.requests.where((r) => r.method == 'DELETE'), isEmpty);
    });
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
