import 'dart:async';

import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:globalpay/core/errors/app_exception.dart';
import 'package:globalpay/core/storage/secure_store.dart';
import 'package:globalpay/services/card_key/card_key_store.dart';
import 'package:globalpay/services/card_key/card_reader.dart';
import 'package:nfc_manager/nfc_manager.dart';

import 'emv_test.dart' show FakeCard, appFci, entry, gpoNoPdol, mcAid, ok, ppse, ppseFci, readRecord, select, tlv;

// NfcCardReader talks to nfc_manager's Android plugin over pigeon channels. These tests answer those channels
// like the phone would (NFC on or off, a tag tapped, the tag lost mid-read), so the reader's own logic runs as is.

const _host = 'dev.flutter.pigeon.nfc_manager.HostApiPigeon';
const _tagDiscovered = 'dev.flutter.pigeon.nfc_manager.FlutterApiPigeon.onTagDiscovered';

/// A tag as nfc_manager's TagPigeon (only what the reader looks at).
class _Tag {
  _Tag(this.id, {this.isoDep = false, this.techList = const ['android.nfc.tech.NfcA']});

  final List<int> id;
  final bool isoDep;
  final List<String> techList;
}

/// Writes [_Tag] the way the plugin's pigeon codec reads a TagPigeon (135) with an IsoDepPigeon (141).
class _TagCodec extends StandardMessageCodec {
  const _TagCodec();

  @override
  void writeValue(WriteBuffer buffer, Object? value) {
    if (value is _Tag) {
      buffer.putUint8(135);
      writeValue(buffer, <Object?>[
        'handle-1',
        Uint8List.fromList(value.id),
        value.techList,
        null, // ndef
        null, // nfcA
        null, // nfcB
        null, // nfcF
        null, // nfcV
        if (value.isoDep) _IsoDep() else null,
        null, // mifareClassic
        null, // mifareUltralight
        null, // ndefFormatable
        null, // nfcBarcode
      ]);
    } else if (value is _IsoDep) {
      buffer.putUint8(141);
      writeValue(buffer, <Object?>[null, null, false]);
    } else {
      super.writeValue(buffer, value);
    }
  }
}

class _IsoDep {}

/// The phone's NFC adapter, as the plugin's host side.
class _FakeNfc {
  /// isEnabled answers this; null: the plugin errors (no NFC hardware).
  bool? enabled = true;

  /// enableReaderMode fails with this code (e.g. NFC switched off just now).
  String? startError;

  /// isoDepSetTimeout fails with this code (the tag left before the read started).
  String? setTimeoutError;

  /// Answers each APDU; null: every transceive fails (the tag was lost).
  Future<Uint8List> Function(Uint8List command)? card;

  int starts = 0;
  int stops = 0;
  final apdus = <Uint8List>[];

  static const _codec = StandardMessageCodec();
  static const _tags = _TagCodec();

  ByteData _ok(Object? value) => _codec.encodeMessage(<Object?>[value])!;

  ByteData _error(String code) => _codec.encodeMessage(<Object?>[code, 'Platform error', null])!;

  void install() {
    final messenger = TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger;
    void on(String method, Future<ByteData?> Function(ByteData? message) handler) =>
        messenger.setMockMessageHandler('$_host.$method', handler);

    on('nfcAdapterIsEnabled', (_) async => enabled == null ? _error('no_nfc') : _ok(enabled));
    on('nfcAdapterEnableReaderMode', (_) async {
      starts++;
      return startError == null ? _ok(null) : _error(startError!);
    });
    on('nfcAdapterDisableReaderMode', (_) async {
      stops++;
      return _ok(null);
    });
    on('isoDepSetTimeout', (_) async => setTimeoutError == null ? _ok(null) : _error(setTimeoutError!));
    on('isoDepTransceive', (message) async {
      final args = _codec.decodeMessage(message) as List<Object?>;
      final command = args[1]! as Uint8List;
      apdus.add(command);
      final answer = card;
      if (answer == null) return _error('io_exception');
      return _ok(await answer(command));
    });
  }

  void uninstall() {
    final messenger = TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger;
    for (final method in [
      'nfcAdapterIsEnabled',
      'nfcAdapterEnableReaderMode',
      'nfcAdapterDisableReaderMode',
      'isoDepSetTimeout',
      'isoDepTransceive',
    ]) {
      messenger.setMockMessageHandler('$_host.$method', null);
    }
  }

  /// A card tapped on the back of the phone.
  Future<void> tap(_Tag tag) async {
    final messenger = TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger;
    await messenger.handlePlatformMessage(_tagDiscovered, _tags.encodeMessage(<Object?>[tag]), (_) {});
  }
}

/// A Mastercard-like test card (a published test PAN) that answers the EMV read.
FakeCard _bankCard() => FakeCard({
  ppse: ok(ppseFci([entry(mcAid, label: 'MASTERCARD', priority: 1)])),
  select(mcAid): ok(appFci(mcAid, 'MASTERCARD')),
  gpoNoPdol: ok(tlv('80', '1980 08010100')),
  readRecord(1, 1): ok('${tlv('70', tlv('5F24', '301231') + tlv('5A', '5413330089020037') + tlv('5F34', '01'))}0000'),
});

TypeMatcher<AppException> _appError(String code) => isA<AppException>().having((e) => e.code, 'code', code);

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  late _FakeNfc nfc;
  late NfcCardReader reader;

  setUp(() {
    nfc = _FakeNfc()..install();
    reader = NfcCardReader();
  });

  tearDown(() async {
    // The plugin is a singleton: drop any tag callback a test left behind.
    await NfcManager.instance.stopSession();
    nfc.uninstall();
  });

  /// Starts a read, waits until the reader session is open, then taps [tags] in order. The read's result.
  Future<CardTap> readTap(List<_Tag> tags) async {
    final outcome = reader.read().then<Object>((tap) => tap, onError: (Object error) => error);
    await pumpEventQueue();
    for (final tag in tags) {
      await nfc.tap(tag);
    }
    final value = await outcome;
    if (value is CardTap) return value;
    throw value;
  }

  group('NfcCardReader.isAvailable', () {
    test('NFC on: available', () async {
      expect(await reader.isAvailable(), isTrue);
    });

    test('NFC switched off: not available', () async {
      nfc.enabled = false;
      expect(await reader.isAvailable(), isFalse);
    });

    test('no NFC hardware (the plugin errors): not available, and no throw', () async {
      nfc.enabled = null;
      expect(await reader.isAvailable(), isFalse);
    });
  });

  group('NfcCardReader.read', () {
    test('a bank card over ISO-DEP: identified by its number, never the UID', () async {
      nfc.card = _bankCard().call;
      final tap = await readTap([_Tag([0x08, 0x11, 0x22, 0x33], isoDep: true)]);
      expect(tap.identifier, 'pan:5413330089020037');
      expect(tap.last4, '0037');
      expect(tap.toString(), isNot(contains('5413330089020037')));
      expect(nfc.stops, 1);
    });

    test('a non-ISO-DEP tag (NTAG / MIFARE): falls back to the UID without sending any APDU', () async {
      final tap = await readTap([
        _Tag([0x04, 0xA1, 0xB2, 0xC3, 0xD4, 0xE5, 0x80], techList: ['android.nfc.tech.MifareUltralight']),
      ]);
      expect(tap.identifier, 'uid:04A1B2C3D4E580');
      expect(tap.last4, 'E580');
      expect(nfc.apdus, isEmpty);
      expect(nfc.stops, 1);
    });

    test('an ISO-DEP card that is not EMV (readEmvCard gives null): falls back to the UID', () async {
      nfc.card = (_) async => Uint8List.fromList([0x6A, 0x82]); // File not found, to everything.
      final tap = await readTap([_Tag([0x04, 0x10, 0x20, 0x30], isoDep: true)]);
      expect(tap.identifier, 'uid:04102030');
      expect(nfc.apdus, isNotEmpty);
    });

    test('tag lost mid-read (transceive throws): today it falls back to the UID, not an error', () async {
      // readEmvCard swallows transceive errors, so a bank card pulled away too early is identified by its UID.
      // A card key registered by PAN then shows "not your registered card" for that tap.
      nfc.card = null;
      final tap = await readTap([_Tag([0x08, 0xAB, 0xCD, 0xEF], isoDep: true)]);
      expect(tap.identifier, 'uid:08ABCDEF');
      expect(nfc.apdus, isNotEmpty);
      expect(nfc.stops, 1);
    });

    test('tag gone before the read starts (setTimeout throws): a plain "couldn\'t read" error', () async {
      nfc.setTimeoutError = 'tag_lost';
      await expectLater(
        readTap([_Tag([0x04, 0x01, 0x02, 0x03], isoDep: true)]),
        throwsA(
          _appError('card_unreadable').having(
            (e) => e.message,
            'message',
            "Couldn't read that card. Hold it still and try again.",
          ),
        ),
      );
      expect(nfc.apdus, isEmpty);
      expect(nfc.stops, 1);
    });

    test('a UID shorter than 2 bytes and no EMV: card_unreadable, never a crash', () async {
      await expectLater(readTap([_Tag([0x04])]), throwsA(_appError('card_unreadable')));
      expect(nfc.stops, 1);
    });

    test('an empty UID and no EMV: card_unreadable', () async {
      await expectLater(readTap([_Tag([])]), throwsA(_appError('card_unreadable')));
    });

    test('tapping twice: the first card counts, the second tap is ignored', () async {
      final tap = await readTap([_Tag([0x04, 0x00, 0x00, 0x01]), _Tag([0x04, 0x00, 0x00, 0x02])]);
      expect(tap.identifier, 'uid:04000001');
      expect(nfc.starts, 1);
      expect(nfc.stops, 1);
    });

    test('stop() cancels a waiting read with tap_cancelled and closes the reader session', () async {
      final read = reader.read();
      await pumpEventQueue();
      expect(nfc.starts, 1);
      unawaited(expectLater(read, throwsA(_appError('tap_cancelled'))));
      await reader.stop();
      await pumpEventQueue();
      expect(nfc.stops, 1);
    });

    test('stop() with no read running does nothing (and does not touch the reader)', () async {
      await reader.stop();
      expect(nfc.stops, 0);
    });

    test('reader timeout or cancel, then a new read: the old one is cancelled, the new one gets the card', () async {
      final first = reader.read();
      unawaited(expectLater(first, throwsA(_appError('tap_cancelled'))));
      await pumpEventQueue();
      // Only one session at a time: a second read cancels the first before it starts its own.
      final second = reader.read();
      await pumpEventQueue();
      expect(nfc.starts, 2);
      expect(nfc.stops, 1);
      await nfc.tap(_Tag([0x04, 0xDE, 0xAD, 0x01]));
      expect((await second).identifier, 'uid:04DEAD01');
    });

    test('NFC switched off when the session starts: read() fails with the platform error', () async {
      // Not mapped to an AppException today: the tap sheet only shows AppExceptions (see the gate edge tests).
      nfc.startError = 'nfc_disabled';
      await expectLater(reader.read(), throwsA(isA<PlatformException>()));
    });
  });

  group('random-UID cards', () {
    test('a card with a random UID (first byte 0x08) reads differently on each tap, so it never matches', () async {
      final store = MemorySecureStore();
      final keys = CardKeyStore(store);

      final first = await readTap([_Tag([0x08, 0x1F, 0x2E, 0x3D])]);
      await keys.register(first);
      final second = await readTap([_Tag([0x08, 0x9A, 0x8B, 0x7C])]);

      expect(first.identifier, isNot(second.identifier));
      expect(first.last4, isNot(second.last4));
      // Reported at approval as "That's not your registered card" (cardKeyMismatch).
      expect(await keys.matches(second), isFalse);
      expect(await keys.matches(first), isTrue);
    });
  });

  group('CardTap edge cases', () {
    test('uidHex pads every byte and is uppercase', () {
      expect(uidHex([0x00, 0x0a, 0xff]), '000AFF');
      expect(uidHex([]), '');
    });

    test('a 2-byte UID (the shortest the reader accepts) uses the whole UID as last 4', () {
      final tap = CardTap.fromUid([0x00, 0x0a]);
      expect(tap.identifier, 'uid:000A');
      expect(tap.last4, '000A');
    });

    test('a 19-digit PAN: last 4 only, and toString never shows the number', () {
      const pan = '6011000990139424123';
      final tap = CardTap.fromPan(pan);
      expect(tap.last4, '4123');
      expect(tap.toString(), 'CardTap(•••• 4123)');
      expect(tap.toString(), isNot(contains(pan.substring(0, 6))));
    });

    test('a UID tap\'s toString shows only the last 4', () {
      final tap = CardTap.fromUid([0x04, 0xA1, 0xB2, 0xC3, 0xD4, 0xE5, 0x80]);
      expect(tap.toString(), isNot(contains('04A1B2C3D4E580')));
      expect(tap.toString(), contains('E580'));
    });
  });
}
