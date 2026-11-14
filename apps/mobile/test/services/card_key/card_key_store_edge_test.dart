import 'package:flutter_test/flutter_test.dart';
import 'package:globalpay/core/storage/secure_store.dart';
import 'package:globalpay/services/card_key/card_key_store.dart';
import 'package:globalpay/services/card_key/card_reader.dart';

// Test numbers and made-up UIDs only.
const _pan = '4111111111114821';
final _card = CardTap.fromPan(_pan);
final _uidCard = CardTap.fromUid([0x04, 0xA1, 0xB2, 0xC3, 0xD4, 0xE5, 0x80]);

void main() {
  group('CardKeyStore edge cases', () {
    test('the stored record never holds the full UID of a UID card', () async {
      final store = MemorySecureStore();
      await CardKeyStore(store).register(_uidCard);
      for (final value in store.values.values) {
        expect(value.toUpperCase(), isNot(contains('04A1B2C3D4E580')));
        expect(value.toUpperCase(), isNot(contains('04A1B2')));
      }
      expect(store.values[CardKeyStore.last4Key], 'E580');
    });

    test('the salt is made once per phone: re-registering the same card gives the same hash', () async {
      final store = MemorySecureStore();
      final keys = CardKeyStore(store);
      await keys.register(_card);
      final salt = store.values[CardKeyStore.saltKey];
      final hash = store.values[CardKeyStore.hashKey];
      await keys.remove();
      expect(store.values[CardKeyStore.saltKey], salt, reason: 'remove keeps the salt');
      await keys.register(_card);
      expect(store.values[CardKeyStore.saltKey], salt);
      expect(store.values[CardKeyStore.hashKey], hash);
    });

    test('registering another card replaces the first: the first no longer approves', () async {
      final keys = CardKeyStore(MemorySecureStore());
      await keys.register(_card);
      await keys.register(_uidCard);
      expect(await keys.matches(_card), isFalse);
      expect(await keys.matches(_uidCard), isTrue);
      expect((await keys.current())!.last4, 'E580');
    });

    test('a different salt for the same card gives a different hash (no match across salts)', () async {
      final store = MemorySecureStore();
      final keys = CardKeyStore(store);
      await keys.register(_card);
      store.values[CardKeyStore.saltKey] = 'ab' * 32;
      expect(await keys.matches(_card), isFalse);
    });

    test('salt lost but hash kept (partial restore): the card is refused, fail closed', () async {
      final store = MemorySecureStore();
      final keys = CardKeyStore(store);
      await keys.register(_card);
      store.values.remove(CardKeyStore.saltKey);
      expect(await keys.current(), isNotNull);
      expect(await keys.matches(_card), isFalse);
      // A fresh salt was made; it is not the card number either.
      expect(store.values[CardKeyStore.saltKey], matches(RegExp(r'^[0-9a-f]{64}$')));
    });

    test('a corrupted or truncated stored hash never matches', () async {
      final store = MemorySecureStore();
      final keys = CardKeyStore(store);
      await keys.register(_card);
      final hash = store.values[CardKeyStore.hashKey]!;
      store.values[CardKeyStore.hashKey] = hash.substring(0, 63);
      expect(await keys.matches(_card), isFalse);
      store.values[CardKeyStore.hashKey] = '${hash}0';
      expect(await keys.matches(_card), isFalse);
      store.values[CardKeyStore.hashKey] = '';
      expect(await keys.matches(_card), isFalse);
    });

    test('a half-written record (no last 4) means no card key: the gate is off', () async {
      final store = MemorySecureStore();
      final keys = CardKeyStore(store);
      await keys.register(_card);
      store.values.remove(CardKeyStore.last4Key);
      expect(await keys.current(), isNull);
    });

    test('the same number as a PAN, a UID or the demo card are different keys', () async {
      final keys = CardKeyStore(MemorySecureStore());
      await keys.register(demoCardTap);
      // A real card with the demo card's number, or any card ending 4821, is not the demo key.
      expect(await keys.matches(CardTap.fromPan('4000001234564821')), isFalse);
      expect(await keys.matches(_card), isFalse);
      expect(await keys.matches(const CardTap(identifier: 'uid:4000001234564821', last4: '4821')), isFalse);
      expect(await keys.matches(demoCardTap), isTrue);
    });

    test('the demo card number is never stored either', () async {
      final store = MemorySecureStore();
      await CardKeyStore(store).register(demoCardTap);
      for (final value in store.values.values) {
        expect(value, isNot(contains('4000001234564821')));
      }
    });
  });
}
