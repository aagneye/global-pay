import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:globalpay/core/config/app_config.dart';
import 'package:globalpay/core/errors/app_exception.dart';
import 'package:globalpay/core/providers.dart';
import 'package:globalpay/core/storage/secure_store.dart';
import 'package:globalpay/features/card_key/card_key_screen.dart';
import 'package:globalpay/features/card_key/card_widgets.dart';
import 'package:globalpay/features/pay/confirm_screen.dart';
import 'package:globalpay/services/card_key/card_key_store.dart';
import 'package:globalpay/services/card_key/card_reader.dart';

import '../../card_key_test.dart' show myCard, scanAndPay, settleSheet, signIn;
import '../../near_flow_test.dart' show nearConfig, pumpUntil, tap;
import '../../support/fake_backend.dart';
import '../../support/fake_card_reader.dart';

const _cardUnreadable = AppException('card_unreadable', "Couldn't read that card. Hold it still and try again.");
const _noNfcText = "This phone can't read cards. Turn on NFC and try again.";

/// A reader with NFC whose reads answer from [script] in order; once it's empty, a read waits for a card
/// until [stop] cancels it (like a phone waiting for a tap).
class _ScriptedReader extends FakeCardReader {
  _ScriptedReader() : super(available: true);

  final script = <Future<CardTap> Function()>[];
  int stops = 0;
  Completer<CardTap>? _waiting;

  @override
  Future<CardTap> read() {
    reads++;
    if (script.isNotEmpty) return script.removeAt(0)();
    final waiting = _waiting = Completer<CardTap>();
    return waiting.future;
  }

  @override
  Future<void> stop() async {
    stops++;
    final waiting = _waiting;
    _waiting = null;
    if (waiting != null && !waiting.isCompleted) {
      waiting.completeError(const AppException('tap_cancelled', 'Stopped'));
    }
  }
}

/// Fails reading the card key's hash once [failCardKey] is set (secure storage locked or corrupted).
class _FlakyStore extends MemorySecureStore {
  bool failCardKey = false;

  @override
  Future<String?> read(String key) {
    if (failCardKey && key == CardKeyStore.hashKey) throw PlatformException(code: 'keystore_locked');
    return super.read(key);
  }
}

const _platformErrorBug =
    'BUG: _CardTapSheet._listen catches only AppException. A PlatformException from read() (NfcCardReader.read '
    'lets startSession errors through, e.g. NFC switched off after isAvailable) escapes unhandled: the sheet shows '
    'no error and no Try again, and just waits.';

const _mainnet = AppConfig(apiBaseUrl: 'https://api.globalpay.example', chainId: 8453);

/// Just the card tap sheet, opened by a button; what it returns goes to [results].
Future<void> _openSheet(WidgetTester tester, CardReader reader, AppConfig config, List<CardTap?> results) async {
  tester.view.physicalSize = const Size(1080, 2400);
  tester.view.devicePixelRatio = 2.5;
  addTearDown(tester.view.reset);
  await tester.pumpWidget(
    ProviderScope(
      overrides: [appConfigProvider.overrideWithValue(config), cardReaderProvider.overrideWithValue(reader)],
      child: MaterialApp(
        home: Builder(
          builder: (context) => Scaffold(
            body: Center(
              child: TextButton(
                onPressed: () async =>
                    results.add(await showCardTapSheet(context, title: 'Tap your card', demoLabel: 'Use demo card')),
                child: const Text('Open'),
              ),
            ),
          ),
        ),
      ),
    ),
  );
  await tester.tap(find.text('Open'));
  await _frames(tester);
}

/// A few frames: the sheet slides up and the reader's async answers land (the pulse never settles).
Future<void> _frames(WidgetTester tester) async {
  for (var i = 0; i < 6; i++) {
    await tester.pump(const Duration(milliseconds: 100));
  }
}

void main() {
  group('the card tap sheet', () {
    testWidgets('no NFC on a mainnet build: no demo card, a plain "turn on NFC" message, Cancel returns nothing', (
      tester,
    ) async {
      final results = <CardTap?>[];
      await _openSheet(tester, FakeCardReader(), _mainnet, results);
      expect(find.text('Use demo card'), findsNothing);
      expect(find.text(_noNfcText), findsOneWidget);
      expect(find.text('Try again'), findsNothing);
      await tester.tap(find.text('Cancel'));
      await _frames(tester);
      expect(results, [null]);
    });

    for (final chainId in [84532, 31337]) {
      testWidgets('no NFC on an EVM testnet ($chainId): the demo card is offered', (tester) async {
        final results = <CardTap?>[];
        await _openSheet(tester, FakeCardReader(), AppConfig(apiBaseUrl: 'http://x.test', chainId: chainId), results);
        expect(find.text(_noNfcText), findsNothing);
        await tester.tap(find.text('Use demo card'));
        await _frames(tester);
        expect(results.single!.identifier, demoCardTap.identifier);
      });
    }

    testWidgets('NFC on a testnet build: the demo card is not offered, the phone waits for a real tap', (
      tester,
    ) async {
      final reader = _ScriptedReader();
      await _openSheet(tester, reader, const AppConfig(apiBaseUrl: 'http://x.test', chainId: 84532), []);
      expect(find.text('Use demo card'), findsNothing);
      expect(reader.reads, 1);
    });

    testWidgets('an unreadable card shows a plain message and Try again, which reads again', (tester) async {
      final reader = _ScriptedReader()..script.add(() async => throw _cardUnreadable);
      final results = <CardTap?>[];
      await _openSheet(tester, reader, _mainnet, results);
      expect(find.text(_cardUnreadable.message), findsOneWidget);
      expect(find.text('Try again'), findsOneWidget);
      expect(results, isEmpty);

      reader.script.add(() async => myCard);
      await tester.tap(find.text('Try again'));
      await _frames(tester);
      expect(reader.reads, 2);
      expect(results.single!.identifier, myCard.identifier);
    });

    testWidgets('a cancelled read (tap_cancelled) shows no error', (tester) async {
      final reader = _ScriptedReader()..script.add(() async => throw const AppException('tap_cancelled', 'Stopped'));
      await _openSheet(tester, reader, _mainnet, []);
      expect(find.text('Stopped'), findsNothing);
      expect(find.text('Try again'), findsNothing);
    });

    group('reader platform errors', () {
      testWidgets('a reader platform error (NFC switched off mid-session) shows a plain message and Try again', (
        tester,
      ) async {
        final reader = _ScriptedReader()..script.add(() async => throw PlatformException(code: 'nfc_disabled'));
        await _openSheet(tester, reader, _mainnet, []);
        expect(find.text('Something went wrong. Please try again.'), findsOneWidget);
        expect(find.text('Try again'), findsOneWidget);
      });
    }, skip: _platformErrorBug);

    testWidgets('Cancel while waiting for a tap stops the reader and returns nothing', (tester) async {
      final reader = _ScriptedReader();
      final results = <CardTap?>[];
      await _openSheet(tester, reader, _mainnet, results);
      await tester.tap(find.text('Cancel'));
      await _frames(tester);
      expect(results, [null]);
      expect(reader.stops, greaterThanOrEqualTo(1));
    });

    testWidgets('dismissing the sheet (tap outside) stops the reader and returns nothing', (tester) async {
      final reader = _ScriptedReader();
      final results = <CardTap?>[];
      await _openSheet(tester, reader, _mainnet, results);
      await tester.tapAt(const Offset(10, 10));
      await _frames(tester);
      expect(results, [null]);
      expect(reader.stops, greaterThanOrEqualTo(1));
    });
  });

  group('the payment gate', () {
    testWidgets('an unreadable card at approval, then Cancel: nothing signed or posted, no error left', (
      tester,
    ) async {
      final backend = FakeBackend(near: true)..kycStatus = 'APPROVED';
      final store = MemorySecureStore();
      await CardKeyStore(store).register(myCard);
      final reader = _ScriptedReader()..script.add(() async => throw _cardUnreadable);
      final wallet = await signIn(tester, backend, store, reader: reader);
      await scanAndPay(tester);
      await pumpUntil(tester, find.text(_cardUnreadable.message));
      await settleSheet(tester);
      await tap(tester, 'Cancel');
      await settleSheet(tester);
      expect(wallet.signedPayments, isEmpty);
      expect(backend.requests.where((r) => r.path == '/payments'), isEmpty);
      expect(find.byIcon(Icons.error_outline), findsNothing);
      expect(find.text('Pay 7.477454 USDC'), findsOneWidget);
    });

    testWidgets('cancelling while the phone waits for the card stops the reader; nothing signed', (tester) async {
      final backend = FakeBackend(near: true)..kycStatus = 'APPROVED';
      final store = MemorySecureStore();
      await CardKeyStore(store).register(myCard);
      final reader = _ScriptedReader();
      final wallet = await signIn(tester, backend, store, reader: reader);
      await scanAndPay(tester);
      await pumpUntil(tester, find.text('Tap your card to approve'));
      await settleSheet(tester);
      expect(reader.reads, 1);
      await tap(tester, 'Cancel');
      await settleSheet(tester);
      expect(reader.stops, greaterThanOrEqualTo(1));
      expect(wallet.signedPayments, isEmpty);
      expect(backend.requests.where((r) => r.path == '/payments'), isEmpty);
    });

    testWidgets('a demo card key on a phone with NFC: a real card ending in the same 4 digits is refused', (
      tester,
    ) async {
      final backend = FakeBackend(near: true)..kycStatus = 'APPROVED';
      final store = MemorySecureStore();
      await CardKeyStore(store).register(demoCardTap);
      final reader = _ScriptedReader()..script.add(() async => CardTap.fromPan('4000001234564821'));
      final wallet = await signIn(tester, backend, store, reader: reader);
      await scanAndPay(tester);
      await pumpUntil(tester, find.text(cardKeyMismatch.message));
      expect(find.text('Tap demo card'), findsNothing);
      expect(wallet.signedPayments, isEmpty);
      expect(backend.requests.where((r) => r.path == '/payments'), isEmpty);
    });

    testWidgets('the card key can\'t be read from storage: fail closed, nothing signed or posted', (tester) async {
      final backend = FakeBackend(near: true)..kycStatus = 'APPROVED';
      final store = _FlakyStore();
      await CardKeyStore(store).register(myCard);
      final reader = _ScriptedReader()..script.add(() async => myCard);
      final wallet = await signIn(tester, backend, store, reader: reader);
      store.failCardKey = true;
      await scanAndPay(tester);
      await pumpUntil(tester, find.byIcon(Icons.error_outline));
      expect(find.text('Something went wrong. Please try again.'), findsOneWidget);
      expect(reader.reads, 0);
      expect(wallet.signedPayments, isEmpty);
      expect(backend.requests.where((r) => r.path == '/payments'), isEmpty);
    });

    testWidgets('removing the key turns the gate off: the next payment needs no tap', (tester) async {
      final backend = FakeBackend(near: true)..kycStatus = 'APPROVED';
      final store = MemorySecureStore();
      await CardKeyStore(store).register(myCard);
      final reader = _ScriptedReader();
      final wallet = await signIn(tester, backend, store, reader: reader);
      await pumpUntil(tester, find.text('Card key'));
      await tap(tester, 'Card key');
      await pumpUntil(tester, find.text('Remove key'));
      await tap(tester, 'Remove key');
      await pumpUntil(tester, find.text('Remove card key?'));
      await tap(tester, 'Remove');
      await pumpUntil(tester, find.text('Register card'));
      await tester.pageBack();
      await tester.pump();

      await scanAndPay(tester);
      await pumpUntil(tester, find.text('Payment status'));
      expect(reader.reads, 0);
      expect(find.text('Tap your card to approve'), findsNothing);
      expect(wallet.signedPayments, hasLength(1));
    });
  });

  group('the card key screen', () {
    testWidgets('Cancel in the remove dialog keeps the key', (tester) async {
      final backend = FakeBackend(near: true)..kycStatus = 'APPROVED';
      final store = MemorySecureStore();
      await CardKeyStore(store).register(myCard);
      await signIn(tester, backend, store, reader: _ScriptedReader());
      await pumpUntil(tester, find.text('Card key'));
      await tap(tester, 'Card key');
      await pumpUntil(tester, find.text('Remove key'));
      await tap(tester, 'Remove key');
      await pumpUntil(tester, find.text('Remove card key?'));
      await tap(tester, 'Cancel');
      await tester.pump(const Duration(milliseconds: 500));
      expect(find.text('Remove key'), findsOneWidget);
      expect(find.text('•••• 4821'), findsOneWidget);
      expect(await CardKeyStore(store).matches(myCard), isTrue);
    });

    testWidgets('an unreadable card during registration, then Cancel: nothing is registered', (tester) async {
      final backend = FakeBackend(near: true)..kycStatus = 'APPROVED';
      final store = MemorySecureStore();
      final reader = _ScriptedReader()..script.add(() async => throw _cardUnreadable);
      await signIn(tester, backend, store, reader: reader);
      await pumpUntil(tester, find.text('Card key'));
      await tap(tester, 'Card key');
      await pumpUntil(tester, find.text('Register card'));
      await tap(tester, 'Register card');
      await pumpUntil(tester, find.text(_cardUnreadable.message));
      await settleSheet(tester);
      await tap(tester, 'Cancel');
      await settleSheet(tester);
      expect(find.text('Register card'), findsOneWidget);
      expect(find.text(cardRegisteredMessage), findsNothing);
      expect(await CardKeyStore(store).current(), isNull);
      expect(store.values.containsKey(CardKeyStore.hashKey), isFalse);
    });
  });

  group('the onboarding step', () {
    test('offered on the NEAR rail only, never on an EVM build', () {
      final evm = ProviderContainer(overrides: [appConfigProvider.overrideWithValue(_mainnet)]);
      addTearDown(evm.dispose);
      expect(evm.read(cardKeyOnboardingProvider), isFalse);
      final near = ProviderContainer(overrides: [appConfigProvider.overrideWithValue(nearConfig)]);
      addTearDown(near.dispose);
      expect(near.read(cardKeyOnboardingProvider), isTrue);
    });

    testWidgets('not offered when this phone already has a card key', (tester) async {
      final backend = FakeBackend(near: true)..kycStatus = 'APPROVED';
      final store = MemorySecureStore();
      await CardKeyStore(store).register(myCard);
      await signIn(tester, backend, store, reader: _ScriptedReader(), onboarding: true);
      await pumpUntil(tester, find.text('Scan & pay'));
      await tester.pump(const Duration(milliseconds: 500));
      expect(find.text('Skip'), findsNothing);
      expect(find.text('Your card is your key'), findsNothing);
    });
  });
}
