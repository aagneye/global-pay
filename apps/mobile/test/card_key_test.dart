import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:globalpay/core/storage/secure_store.dart';
import 'package:globalpay/features/card_key/card_key_screen.dart';
import 'package:globalpay/services/card_key/card_key_store.dart';
import 'package:globalpay/services/card_key/card_reader.dart';

import 'near_flow_test.dart' show continueWithNear, nearApp, pumpUntil, qr250, start, tap;
import 'support/fake_backend.dart';
import 'support/fake_card_reader.dart';
import 'support/near_vectors.dart';
import 'support/spy_near_wallet.dart';

const myPan = '4111111111114821';
final myCard = CardTap.fromPan(myPan);
final otherCard = CardTap.fromPan('5500000000009999');

/// Signs in on the NEAR rail and waits for Home.
Future<SpyNearWallet> signIn(
  WidgetTester tester,
  FakeBackend backend,
  MemorySecureStore store, {
  FakeCardReader? reader,
  bool onboarding = false,
}) async {
  final wallet = SpyNearWallet(store: store, importSeed: nearTestSeed);
  await start(tester, nearApp(backend, store, wallet, cardReader: reader, onboarding: onboarding));
  await pumpUntil(tester, find.text(continueWithNear));
  await tap(tester, continueWithNear);
  return wallet;
}

/// From Home: scan the 250 THB PromptPay QR and press Pay.
Future<void> scanAndPay(WidgetTester tester) async {
  await pumpUntil(tester, find.text('Scan & pay'));
  await tap(tester, 'Scan & pay');
  await pumpUntil(tester, find.byKey(const Key('qr-text')));
  await tester.enterText(find.byKey(const Key('qr-text')), qr250);
  await tap(tester, 'Continue');
  await pumpUntil(tester, find.text('Pay 7.477454 USDC'));
  await tap(tester, 'Pay 7.477454 USDC');
}

/// Lets the card tap sheet finish sliding up (its pulse never settles, so no pumpAndSettle).
Future<void> settleSheet(WidgetTester tester) => tester.pump(const Duration(milliseconds: 500));

void main() {
  group('CardKeyStore', () {
    test('keeps only a salted hash and the last 4, never the card number', () async {
      final store = MemorySecureStore();
      final keys = CardKeyStore(store);
      expect(await keys.current(), isNull);
      expect(await keys.matches(myCard), isFalse);

      final key = await keys.register(myCard);
      expect(key.last4, '4821');
      expect((await keys.current())!.last4, '4821');
      expect(await keys.matches(myCard), isTrue);
      expect(await keys.matches(otherCard), isFalse);
      expect(await keys.matches(CardTap.fromUid([0x04, 0xA1, 0x48, 0x21])), isFalse);
      expect(store.values.keys, unorderedEquals([CardKeyStore.saltKey, CardKeyStore.hashKey, CardKeyStore.last4Key]));
      for (final value in store.values.values) {
        expect(value, isNot(contains(myPan)));
        expect(value, isNot(contains('411111')));
      }
      expect(store.values[CardKeyStore.hashKey], matches(RegExp(r'^[0-9a-f]{64}$')));

      await keys.remove();
      expect(await keys.current(), isNull);
      expect(await keys.matches(myCard), isFalse);
    });

    test('salts per phone: the same card hashes differently on another phone', () async {
      final a = MemorySecureStore();
      final b = MemorySecureStore();
      await CardKeyStore(a).register(myCard);
      await CardKeyStore(b).register(myCard);
      expect(a.values[CardKeyStore.hashKey], isNot(b.values[CardKeyStore.hashKey]));
      expect(a.values[CardKeyStore.saltKey], hasLength(64));
    });

    test('identifies bank cards by number and other cards by UID', () {
      expect(myCard.last4, '4821');
      expect(myCard.toString(), isNot(contains(myPan)));
      final uid = CardTap.fromUid([0x04, 0xA1, 0xB2, 0xC3, 0xD4, 0xE5, 0x80]);
      expect(uid.identifier, 'uid:04A1B2C3D4E580');
      expect(uid.last4, 'E580');
      expect(demoCardTap.last4, '4821');
    });
  });

  testWidgets('registers the demo card from Home (no NFC on a testnet build), then removes it', (tester) async {
    final backend = FakeBackend(near: true)..kycStatus = 'APPROVED';
    final store = MemorySecureStore();
    await signIn(tester, backend, store);
    await pumpUntil(tester, find.text('Card key'));
    await tap(tester, 'Card key');
    await pumpUntil(tester, find.text('Your card is your key'));
    expect(find.textContaining('No special crypto card'), findsOneWidget);
    await tap(tester, 'Register card');
    await pumpUntil(tester, find.text('Tap your contactless card on the back of your phone'));
    await settleSheet(tester);
    await tap(tester, 'Use demo card');
    await pumpUntil(tester, find.text(cardRegisteredMessage));
    expect(find.text('•••• 4821'), findsOneWidget);
    expect(find.text('Remove key'), findsOneWidget);
    expect(await CardKeyStore(store).matches(demoCardTap), isTrue);

    await tap(tester, 'Remove key');
    await pumpUntil(tester, find.text('Remove card key?'));
    await tap(tester, 'Remove');
    await pumpUntil(tester, find.text('Register card'));
    expect(await CardKeyStore(store).current(), isNull);
  });

  testWidgets('registers a bank card read over NFC', (tester) async {
    final backend = FakeBackend(near: true)..kycStatus = 'APPROVED';
    final store = MemorySecureStore();
    final reader = FakeCardReader(available: true, card: myCard);
    await signIn(tester, backend, store, reader: reader);
    await pumpUntil(tester, find.text('Card key'));
    await tap(tester, 'Card key');
    await pumpUntil(tester, find.text('Register card'));
    await tap(tester, 'Register card');
    await pumpUntil(tester, find.text(cardRegisteredMessage));
    expect(find.text('Use demo card'), findsNothing);
    expect(find.text('•••• 4821'), findsOneWidget);
    expect(reader.reads, 1);
    expect(await CardKeyStore(store).matches(myCard), isTrue);
    // Nothing about the card went to the backend.
    expect(backend.requests.map((r) => '${r.path} ${r.body}').join(), isNot(contains('4821')));
  });

  group('the payment gate', () {
    testWidgets('no card key: pays with the fingerprint only, as before', (tester) async {
      final backend = FakeBackend(near: true)..kycStatus = 'APPROVED';
      final store = MemorySecureStore();
      final reader = FakeCardReader(available: true, card: myCard);
      final wallet = await signIn(tester, backend, store, reader: reader);
      await scanAndPay(tester);
      await pumpUntil(tester, find.text('Payment status'));
      expect(reader.reads, 0);
      expect(find.text('Tap your card to approve'), findsNothing);
      expect(wallet.signedPayments, hasLength(1));
    });

    testWidgets('the registered card taps: then it signs and pays', (tester) async {
      final backend = FakeBackend(near: true)..kycStatus = 'APPROVED';
      final store = MemorySecureStore();
      await CardKeyStore(store).register(myCard);
      final reader = FakeCardReader(available: true, card: myCard);
      final wallet = await signIn(tester, backend, store, reader: reader);
      await scanAndPay(tester);
      await pumpUntil(tester, find.text('Payment status'));
      expect(reader.reads, 1);
      expect(wallet.signedPayments, hasLength(1));
      expect(backend.requests.where((r) => r.path == '/payments'), hasLength(1));
    });

    testWidgets('another card: refused, nothing signed or posted', (tester) async {
      final backend = FakeBackend(near: true)..kycStatus = 'APPROVED';
      final store = MemorySecureStore();
      await CardKeyStore(store).register(myCard);
      final reader = FakeCardReader(available: true, card: otherCard);
      final wallet = await signIn(tester, backend, store, reader: reader);
      await scanAndPay(tester);
      await pumpUntil(tester, find.text("That's not your registered card. Nothing was signed."));
      expect(wallet.signedPayments, isEmpty);
      expect(backend.requests.where((r) => r.path == '/payments'), isEmpty);
      expect(find.text('Pay 7.477454 USDC'), findsOneWidget);

      // The right card then works.
      reader.card = myCard;
      await tap(tester, 'Pay 7.477454 USDC');
      await pumpUntil(tester, find.text('Payment status'));
      expect(wallet.signedPayments, hasLength(1));
    });

    testWidgets('no NFC on testnet: the prompt offers the demo card; cancelling signs nothing', (tester) async {
      final backend = FakeBackend(near: true)..kycStatus = 'APPROVED';
      final store = MemorySecureStore();
      await CardKeyStore(store).register(demoCardTap);
      final wallet = await signIn(tester, backend, store);
      await scanAndPay(tester);
      await pumpUntil(tester, find.text('Tap your card to approve'));
      expect(find.textContaining('•••• 4821'), findsOneWidget);
      await settleSheet(tester);
      await tap(tester, 'Cancel');
      await tester.pump(const Duration(milliseconds: 500));
      expect(wallet.signedPayments, isEmpty);
      expect(find.byIcon(Icons.error_outline), findsNothing);

      await tap(tester, 'Pay 7.477454 USDC');
      await pumpUntil(tester, find.text('Tap demo card'));
      await settleSheet(tester);
      await tap(tester, 'Tap demo card');
      await pumpUntil(tester, find.text('Payment status'));
      expect(wallet.signedPayments, hasLength(1));
    });
  });

  testWidgets('a first sign-in offers the card key step, which can be skipped (and is offered once)', (tester) async {
    final backend = FakeBackend(near: true)..kycStatus = 'APPROVED';
    final store = MemorySecureStore();
    await signIn(tester, backend, store, onboarding: true);
    await pumpUntil(tester, find.text('Skip'));
    expect(find.text('Your card is your key'), findsOneWidget);
    expect(find.textContaining('Tap your contactless card to make it your wallet key'), findsOneWidget);
    await tap(tester, 'Skip');
    await pumpUntil(tester, find.text('Scan & pay'));
    await tester.pump(const Duration(milliseconds: 500));
    expect(find.text('Skip'), findsNothing);
  });

  testWidgets('the card key step registers the card, then continues to Home', (tester) async {
    final backend = FakeBackend(near: true)..kycStatus = 'APPROVED';
    final store = MemorySecureStore();
    await signIn(tester, backend, store, onboarding: true);
    await pumpUntil(tester, find.text('Register card'));
    await tap(tester, 'Register card');
    await pumpUntil(tester, find.text('Use demo card'));
    await settleSheet(tester);
    await tap(tester, 'Use demo card');
    await pumpUntil(tester, find.text('Continue'));
    expect(find.text(cardRegisteredMessage), findsOneWidget);
    await tap(tester, 'Continue');
    await pumpUntil(tester, find.text('Scan & pay'));
  });
}
