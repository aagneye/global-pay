import 'dart:async';

import 'package:globalpay/core/errors/app_exception.dart';
import 'package:globalpay/services/card_key/emv.dart';
import 'package:nfc_manager/nfc_manager.dart';
import 'package:nfc_manager/nfc_manager_android.dart';

/// A card tapped on the phone: what identifies it, and the last 4 to show.
///
/// [identifier] may hold a bank card number: keep it in memory only (the card key stores a salted hash of it),
/// and never log or send it.
class CardTap {
  const CardTap({required this.identifier, required this.last4});

  /// A bank card, by its number (PAN).
  factory CardTap.fromPan(String pan) => CardTap(identifier: 'pan:$pan', last4: pan.substring(pan.length - 4));

  /// Any other NFC card, by its tag UID.
  factory CardTap.fromUid(List<int> uid) {
    final hex = uidHex(uid);
    return CardTap(identifier: 'uid:$hex', last4: hex.substring(hex.length - 4));
  }

  final String identifier;
  final String last4;

  @override
  String toString() => 'CardTap(•••• $last4)';
}

/// The testnet demo card, for phones without NFC (the emulator).
const demoCardTap = CardTap(identifier: 'demo:4000001234564821', last4: '4821');

/// The UID as uppercase hex: [0x04, 0xA1] -> "04A1".
String uidHex(List<int> id) => id.map((byte) => byte.toRadixString(16).padLeft(2, '0')).join().toUpperCase();

/// Reads a card tapped on the back of the phone (NFC reader mode). Behind an interface so tests (and the
/// emulator, which has no NFC) don't need a reader.
abstract interface class CardReader {
  /// Whether this phone can read cards now (it has NFC, and it's on).
  Future<bool> isAvailable();

  /// Waits for a card: a bank card by its number (EMV), any other card by its UID. [stop] cancels.
  Future<CardTap> read();

  Future<void> stop();
}

/// Reads cards with `nfc_manager` (Android): EMV over ISO-DEP first, the tag UID when that gives nothing.
class NfcCardReader implements CardReader {
  NfcCardReader();

  Completer<CardTap>? _pending;

  static const _unreadable = AppException('card_unreadable', "Couldn't read that card. Hold it still and try again.");

  @override
  Future<bool> isAvailable() async {
    try {
      return await NfcManager.instance.isAvailable();
    } on Object {
      return false;
    }
  }

  @override
  Future<CardTap> read() async {
    await stop();
    final completer = _pending = Completer<CardTap>();
    await NfcManager.instance.startSession(
      pollingOptions: {NfcPollingOption.iso14443},
      onDiscovered: (tag) async {
        if (completer.isCompleted) return;
        try {
          EmvCardId? emv;
          final isoDep = IsoDepAndroid.from(tag);
          if (isoDep != null) {
            await isoDep.setTimeout(3000);
            emv = await readEmvCard((command) => isoDep.transceive(command));
          }
          final uid = NfcTagAndroid.from(tag)?.id;
          if (emv != null) {
            completer.complete(CardTap.fromPan(emv.pan));
          } else if (uid != null && uid.length >= 2) {
            completer.complete(CardTap.fromUid(uid));
          } else {
            completer.completeError(_unreadable);
          }
        } on Object catch (_) {
          if (!completer.isCompleted) completer.completeError(_unreadable);
        } finally {
          _pending = null;
          await NfcManager.instance.stopSession();
        }
      },
    );
    return completer.future;
  }

  @override
  Future<void> stop() async {
    final pending = _pending;
    _pending = null;
    if (pending != null && !pending.isCompleted) {
      pending.completeError(const AppException('tap_cancelled', 'Stopped'));
      try {
        await NfcManager.instance.stopSession();
      } on Object {
        // No session running.
      }
    }
  }
}
