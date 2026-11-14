import 'dart:convert';

import 'package:blockchain_utils/blockchain_utils.dart';
import 'package:dio/dio.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:globalpay/app/app.dart';
import 'package:globalpay/core/config/app_config.dart';
import 'package:globalpay/core/providers.dart';
import 'package:globalpay/core/storage/secure_store.dart';
import 'package:globalpay/data/api/api_client.dart';
import 'package:globalpay/features/history/history_screen.dart';
import 'package:globalpay/features/scan/scan_screen.dart';
import 'package:globalpay/services/card_key/card_reader.dart';
import 'package:globalpay/services/push/push_service.dart';
import 'package:globalpay/services/wallet/near/borsh.dart';

import 'support/borsh_reader.dart';
import 'support/fake_backend.dart';
import 'support/fake_card_reader.dart';
import 'support/fake_tap.dart';
import 'support/near_vectors.dart';
import 'support/spy_near_wallet.dart';

/// A dynamic PromptPay QR for 250.00 THB at GLOBALPAY TEST CAFE (from packages/fixtures).
const qr250 =
    '00020101021230600016A00000067701011201150999999999999010207INV00010306TABLE753037645406250.005802TH'
    '5919GLOBALPAY TEST CAFE6007BANGKOK6304E9FD';

/// A static UPI merchant QR (no amount): Chai Point in Bengaluru.
const upiStatic = 'upi://pay?pa=chaipoint@okicici&pn=Chai%20Point&mc=5812&tr=CHAI42&cu=INR';

/// The app on the NEAR rail, with the test contracts the fake backend uses.
const nearConfig = AppConfig(
  apiBaseUrl: 'http://backend.test',
  chainId: 31337,
  settlementRail: SettlementRail.near,
  nearUsdcContract: FakeBackend.nearUsdc,
  nearSettlementContract: FakeBackend.nearSettlement,
);

/// [wallet] is the NEAR wallet, with an in-memory store. Vault off, push off, no NFC unless [cardReader] has it.
/// [onboarding]: offer the card key step after the first sign-in.
Widget nearApp(
  FakeBackend backend,
  SecureStore store,
  SpyNearWallet wallet, {
  AppConfig config = nearConfig,
  CardReader? cardReader,
  bool onboarding = false,
}) {
  return ProviderScope(
    overrides: [
      appConfigProvider.overrideWithValue(config),
      cardReaderProvider.overrideWithValue(cardReader ?? FakeCardReader()),
      cardKeyOnboardingProvider.overrideWithValue(onboarding),
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

  testWidgets('pays a PromptPay QR with a gasless meta transaction and follows it to SETTLED', (tester) async {
    final backend = FakeBackend(near: true);
    final store = MemorySecureStore();
    final wallet = SpyNearWallet(store: store, importSeed: nearTestSeed);

    await start(tester, nearApp(backend, store, wallet));
    await pumpUntil(tester, find.text(continueWithNear));
    await tap(tester, continueWithNear);
    await pumpUntil(tester, find.text('Verify your identity'));
    await tap(tester, 'Continue');
    await pumpUntil(tester, find.byKey(const Key('balance')));

    // Home: the card says NEAR; tap to pay and Add money are EVM-only, so only Receive is left.
    expect(find.text('10,000.00', findRichText: true), findsOneWidget);
    expect(find.text('USDC · NEAR'), findsOneWidget);
    for (final hidden in ['Request', 'Pay by tap', 'Add money']) {
      expect(find.text(hidden), findsNothing, reason: hidden);
    }
    expect(find.text('Receive'), findsOneWidget);
    await tester.pump(const Duration(milliseconds: 300));
    expect(backend.requests.where((r) => r.path == '/devices'), isEmpty);

    await tap(tester, 'Scan & pay');
    await pumpUntil(tester, find.byKey(const Key('qr-text')));
    await tester.enterText(find.byKey(const Key('qr-text')), qr250);
    await tap(tester, 'Continue');
    await pumpUntil(tester, find.text('Pay 7.477454 USDC'));
    expect((backend.requests.lastWhere((r) => r.path == '/quotes').body as Map)['payer'], nearTestAccount);

    await tap(tester, 'Pay 7.477454 USDC');
    await pumpUntil(tester, find.text('Payment status'));
    final submitted = backend.requests.singleWhere((r) => r.path == '/payments').body as Map;
    expect(submitted.keys, unorderedEquals(['quoteId', 'signedDelegate']));
    expect(submitted['quoteId'], FakeBackend.quoteId);

    // The posted SignedDelegate is exactly the quote's ft_transfer_call, signed by this wallet's key.
    final sent = wallet.signedPayments.single;
    final delegate = decodeSignedDelegate(submitted['signedDelegate'] as String);
    expect(delegate.senderId, nearTestAccount);
    expect(delegate.receiverId, FakeBackend.nearUsdc);
    expect(delegate.methodName, 'ft_transfer_call');
    expect(
      delegate.args,
      jsonEncode({'receiver_id': FakeBackend.nearSettlement, 'amount': '7477454', 'msg': sent.args.msg}),
    );
    expect(delegate.gas, BigInt.parse('100000000000000'));
    expect(delegate.deposit, BigInt.one);
    expect(delegate.nonce, BigInt.parse('190000000000001'));
    expect(delegate.maxBlockHeight, BigInt.parse('187654321'));
    expect(BytesUtils.toHexString(delegate.publicKey), nearTestAccount);
    final digest = QuickCrypto.sha256Hash([...(BorshWriter()..u32(1073742190)).toBytes(), ...delegate.delegateBytes]);
    expect(Ed25519Verifier.fromKeyBytes(delegate.publicKey).verify(digest, delegate.signature), isTrue);

    await pumpUntil(tester, find.text('The merchant received ฿250.00.'), maxFrames: 50);
    await tap(tester, 'Done');
    await pumpUntil(tester, find.text('GLOBALPAY TEST CAFE'));

    // History shows payments only: the NEAR rail has no deposits or tap payments to ask for.
    await tap(tester, 'History');
    await pumpUntil(tester, find.byType(PaymentTile));
    expect(find.byIcon(Icons.error_outline), findsNothing);
    expect(backend.requests.where((r) => r.path.startsWith('/p2p') || r.path == '/me/deposits'), isEmpty);
  });

  testWidgets('pays a static UPI QR in rupees: ₹ amount entry, quote, gasless NEAR payment, merchant paid', (
    tester,
  ) async {
    final backend = FakeBackend(near: true)..kycStatus = 'APPROVED';
    final store = MemorySecureStore();
    final wallet = SpyNearWallet(store: store, importSeed: nearTestSeed);
    await start(tester, nearApp(backend, store, wallet));
    await pumpUntil(tester, find.text(continueWithNear));
    await tap(tester, continueWithNear);
    await pumpUntil(tester, find.text('Scan & pay'));

    await tap(tester, 'Scan & pay');
    await pumpUntil(tester, find.byKey(const Key('qr-text')));
    await tester.enterText(find.byKey(const Key('qr-text')), upiStatic);
    await tap(tester, 'Continue');

    // The payee from the QR, and the amount asked for in rupees.
    await pumpUntil(tester, find.text('Chai Point'));
    expect(find.text('chaipoint@okicici · Ref CHAI42'), findsOneWidget);
    expect(find.text('UPI'), findsOneWidget);
    expect(find.text('₹'), findsOneWidget);
    expect(find.text('Amount in rupees'), findsOneWidget);
    await tester.enterText(find.byKey(const Key('amount')), '250');
    await tap(tester, 'Get quote');
    await pumpUntil(tester, find.text('Pay 2.994012 USDC'));
    final quoteRequest = backend.requests.lastWhere((r) => r.path == '/quotes').body as Map;
    expect(quoteRequest['qrPayload'], upiStatic);
    expect(quoteRequest['fiatAmountMinor'], '25000');
    expect(find.text('₹250.00'), findsOneWidget);
    expect(find.text('84.33 INR/USDC'), findsOneWidget);

    await tap(tester, 'Pay 2.994012 USDC');
    await pumpUntil(tester, find.text('Payment status'));
    final delegate = decodeSignedDelegate(
      (backend.requests.singleWhere((r) => r.path == '/payments').body as Map)['signedDelegate'] as String,
    );
    expect(delegate.methodName, 'ft_transfer_call');
    expect(jsonDecode(delegate.args)['amount'], FakeBackend.upiTokenAmount);
    expect(wallet.signedPayments, hasLength(1));

    await pumpUntil(tester, find.text('The merchant received ₹250.00.'), maxFrames: 50);
    expect(find.text('UPI reference'), findsOneWidget);
    expect(find.text(FakeBackend.upiReference), findsOneWidget);
    expect(find.text('Paying the merchant in rupees'), findsOneWidget);
    await tap(tester, 'Done');
    await pumpUntil(tester, find.byType(PaymentTile));
    expect(find.descendant(of: find.byType(PaymentTile), matching: find.text('₹250.00')), findsOneWidget);
    expect(find.descendant(of: find.byType(PaymentTile), matching: find.text('Chai Point')), findsOneWidget);
  });

  testWidgets('says what is wrong with a malformed UPI QR', (tester) async {
    final backend = FakeBackend(near: true)..kycStatus = 'APPROVED';
    final store = MemorySecureStore();
    await start(tester, nearApp(backend, store, SpyNearWallet(store: store, importSeed: nearTestSeed)));
    await pumpUntil(tester, find.text(continueWithNear));
    await tap(tester, continueWithNear);
    await pumpUntil(tester, find.text('Scan & pay'));
    await tap(tester, 'Scan & pay');
    await pumpUntil(tester, find.byKey(const Key('qr-text')));
    await tester.enterText(find.byKey(const Key('qr-text')), 'upi://pay?pa=chaipoint@okicici&am=10&cu=USD');
    await tap(tester, 'Continue');
    await pumpUntil(tester, find.textContaining('Only rupees (INR) are supported'));
    expect(backend.requests.where((r) => r.path == '/quotes'), isEmpty);
  });

  testWidgets("asks to try again while a new account's testnet onboarding finishes", (tester) async {
    final backend = FakeBackend(near: true)
      ..kycStatus = 'APPROVED'
      ..nearAccountPending = 1;
    final store = MemorySecureStore();
    await start(tester, nearApp(backend, store, SpyNearWallet(store: store)));
    await pumpUntil(tester, find.text(continueWithNear));
    await tap(tester, continueWithNear);
    await pumpUntil(tester, find.text('Scan & pay'));
    await tap(tester, 'Scan & pay');
    await pumpUntil(tester, find.byKey(const Key('qr-text')));
    await tester.enterText(find.byKey(const Key('qr-text')), qr250);
    await tap(tester, 'Continue');

    await pumpUntil(tester, find.text('Your testnet account is still being set up. Try again in a few seconds.'));
    await tap(tester, 'Try again');
    await pumpUntil(tester, find.text('Pay 7.477454 USDC'));
    expect(find.textContaining('still being set up'), findsNothing);
  });

  testWidgets('Receive shows the NEAR account and the test USDC contract', (tester) async {
    final backend = FakeBackend(near: true)..kycStatus = 'APPROVED';
    final store = MemorySecureStore();
    await start(tester, nearApp(backend, store, SpyNearWallet(store: store, importSeed: nearTestSeed)));
    await pumpUntil(tester, find.text(continueWithNear));
    await tap(tester, continueWithNear);
    await pumpUntil(tester, find.text('Receive'));
    await tap(tester, 'Receive');
    await pumpUntil(tester, find.textContaining('on NEAR testnet'));
    expect(find.textContaining(FakeBackend.nearUsdc), findsOneWidget);
    expect(find.text(nearTestAccount), findsOneWidget);
  });

  group('refuses to sign a tampered nearPayment: nothing is signed or posted', () {
    Future<void> payTampered(
      WidgetTester tester,
      void Function(Map<String, dynamic> payment) tamper,
      String what,
    ) async {
      final backend = FakeBackend(near: true)
        ..kycStatus = 'APPROVED'
        ..tamperNear = tamper;
      final store = MemorySecureStore();
      final wallet = SpyNearWallet(store: store, importSeed: nearTestSeed);
      await start(tester, nearApp(backend, store, wallet));
      await pumpUntil(tester, find.text(continueWithNear));
      await tap(tester, continueWithNear);
      await pumpUntil(tester, find.text('Scan & pay'));
      await tap(tester, 'Scan & pay');
      await pumpUntil(tester, find.byKey(const Key('qr-text')));
      await tester.enterText(find.byKey(const Key('qr-text')), qr250);
      await tap(tester, 'Continue');
      await pumpUntil(tester, find.text('Pay 7.477454 USDC'));
      await tap(tester, 'Pay 7.477454 USDC');

      await pumpUntil(tester, find.textContaining('Stopped before signing'));
      expect(find.textContaining('($what)'), findsOneWidget);
      expect(find.textContaining('Nothing was signed'), findsOneWidget);
      expect(wallet.signedPayments, isEmpty);
      expect(backend.requests.where((r) => r.path == '/payments'), isEmpty);
      expect(find.text('Pay 7.477454 USDC'), findsOneWidget);
    }

    /// Rewrites the signed quote inside msg (the quote JSON is a string inside the msg JSON).
    void Function(Map<String, dynamic>) quoteField(String key, Object value) => (payment) {
      final args = payment['args'] as Map<String, dynamic>;
      final msg = jsonDecode(args['msg'] as String) as Map<String, dynamic>;
      final quote = jsonDecode(msg['quote'] as String) as Map<String, dynamic>..[key] = value;
      args['msg'] = jsonEncode({...msg, 'quote': jsonEncode(quote)});
    };

    testWidgets('to another token contract', (tester) async {
      await payTampered(tester, (p) => p['receiverId'] = 'fake-usdc.testnet', 'the token');
    });

    testWidgets('for more than the quote', (tester) async {
      await payTampered(tester, (p) => (p['args'] as Map)['amount'] = '7477454000', 'the amount');
    });

    testWidgets('to someone other than the settlement contract', (tester) async {
      await payTampered(tester, (p) => (p['args'] as Map)['receiver_id'] = 'attacker.testnet', 'the recipient');
    });

    testWidgets('carrying a quote for another payment', (tester) async {
      await payTampered(tester, quoteField('quote_id', '0x${'cd' * 32}'), 'the payment ID');
    });
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
