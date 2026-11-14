import 'dart:convert';
import 'dart:math';

import 'package:blockchain_utils/blockchain_utils.dart';
import 'package:globalpay/core/storage/secure_store.dart';
import 'package:globalpay/services/card_key/card_reader.dart';

/// The registered card key: only its last 4 digits are known.
class CardKey {
  const CardKey({required this.last4});

  final String last4;
}

/// The card that approves payments on this phone: "your card is your key".
///
/// It keeps only `sha256(deviceSalt ‖ identifier)` and the last 4 digits, in secure storage, with a random salt
/// made once per phone. The card number itself is never stored, logged or sent.
class CardKeyStore {
  CardKeyStore(this._store);

  final SecureStore _store;

  static const saltKey = 'card_key_salt';
  static const hashKey = 'card_key_hash';
  static const last4Key = 'card_key_last4';

  /// The registered card, or null when there's none (payments then need the fingerprint only).
  Future<CardKey?> current() async {
    final hash = await _store.read(hashKey);
    final last4 = await _store.read(last4Key);
    return hash == null || last4 == null ? null : CardKey(last4: last4);
  }

  /// Makes [card] this phone's card key, replacing any other.
  Future<CardKey> register(CardTap card) async {
    await _store.write(hashKey, await _hash(card));
    await _store.write(last4Key, card.last4);
    return CardKey(last4: card.last4);
  }

  /// Whether [card] is the registered card key.
  Future<bool> matches(CardTap card) async {
    final expected = await _store.read(hashKey);
    if (expected == null) return false;
    final actual = await _hash(card);
    // Constant time, though both sides are on this phone.
    var diff = expected.length ^ actual.length;
    for (var i = 0; i < min(expected.length, actual.length); i++) {
      diff |= expected.codeUnitAt(i) ^ actual.codeUnitAt(i);
    }
    return diff == 0;
  }

  /// Forgets the card key. Payments then need the fingerprint only.
  Future<void> remove() async {
    await _store.delete(hashKey);
    await _store.delete(last4Key);
  }

  Future<String> _hash(CardTap card) async {
    final salt = BytesUtils.fromHexString(await _salt());
    return BytesUtils.toHexString(QuickCrypto.sha256Hash([...salt, ...utf8.encode(card.identifier)]));
  }

  Future<String> _salt() async {
    final existing = await _store.read(saltKey);
    if (existing != null) return existing;
    final random = Random.secure();
    final salt = BytesUtils.toHexString(List<int>.generate(32, (_) => random.nextInt(256)));
    await _store.write(saltKey, salt);
    return salt;
  }
}
