import 'dart:math';
import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:globalpay/services/card_key/emv.dart';

// All PANs here are well-known test numbers or made up; none belongs to a real card.

String _clean(String hex) => hex.replaceAll(RegExp(r'\s'), '').toUpperCase();

Uint8List bytes(String hex) {
  final clean = _clean(hex);
  return Uint8List.fromList([
    for (var i = 0; i < clean.length; i += 2) int.parse(clean.substring(i, i + 2), radix: 16),
  ]);
}

String hexOf(List<int> data) => [for (final b in data) b.toRadixString(16).padLeft(2, '0')].join().toUpperCase();

String ascii(String text) => hexOf(text.codeUnits);

/// One TLV in hex, with a BER length computed from the value.
String tlv(String tag, String value) {
  final n = _clean(value).length ~/ 2;
  final length = n < 0x80
      ? hexOf([n])
      : n <= 0xFF
      ? '81${hexOf([n])}'
      : '82${hexOf([n >> 8, n & 0xFF])}';
  return '${_clean(tag)}$length${_clean(value)}';
}

String ok(String data) => '${_clean(data)}9000';

/// The byte count of [data] as one hex byte, for 6C xx / 61 xx answers.
String lengthOf(String data) => hexOf([_clean(data).length ~/ 2]);

/// A card that answers from a map of command hex → response hex and records every command it was sent.
class FakeCard {
  FakeCard(Map<String, String> responses) : _responses = {for (final e in responses.entries) _clean(e.key): e.value};

  final Map<String, String> _responses;
  final sent = <String>[];

  Future<Uint8List> call(Uint8List command) async {
    final hex = hexOf(command);
    sent.add(hex);
    return bytes(_responses[hex] ?? '6D00');
  }
}

class FixedRandom implements Random {
  @override
  int nextInt(int max) => 0xA5 % max;

  @override
  bool nextBool() => false;

  @override
  double nextDouble() => 0;
}

const ppse = '00A404000E 325041592E5359532E4444463031 00';
const pse = '00A404000E 315041592E5359532E4444463031 00';
const visaAid = 'A0000000031010';
const electronAid = 'A0000000032010';
const mcAid = 'A0000000041010';
const amexAid = 'A00000002501';
const gpoNoPdol = '80A8000002830000';

String select(String aid) => '00A40400${lengthOf(aid)}${aid}00';

String readRecord(int sfi, int record) => '00B2${hexOf([record, (sfi << 3) | 4])}00';

String entry(String aid, {String? label, int? priority}) => tlv(
  '61',
  tlv('4F', aid) +
      (label == null ? '' : tlv('50', ascii(label))) +
      (priority == null ? '' : tlv('87', hexOf([priority]))),
);

String ppseFci(List<String> entries) =>
    tlv('6F', tlv('84', ascii('2PAY.SYS.DDF01')) + tlv('A5', tlv('BF0C', entries.join())));

String appFci(String aid, String label, {String? pdol}) =>
    tlv('6F', tlv('84', aid) + tlv('A5', tlv('50', ascii(label)) + (pdol == null ? '' : tlv('9F38', pdol))));

Future<EmvCardId?> read(FakeCard card) => readEmvCard(card.call, now: DateTime(2026, 11, 14), random: FixedRandom());

List<String> commands(List<String> hex) => [for (final h in hex) _clean(h)];

void main() {
  group('parseTlv', () {
    test('reads multi-byte tags and nested constructed objects', () {
      final tlvs = parseTlv(bytes(tlv('6F', tlv('84', 'AABB') + tlv('A5', tlv('BF0C', tlv('9F38', '9F6604'))))));

      expect(tlvs, hasLength(1));
      expect(tlvs.first.tag, 0x6F);
      expect([for (final t in tlvs.first.children) t.tag], [0x84, 0xA5]);
      expect(tlvs.first.children.first.children, isEmpty);
      expect(findTag(tlvs, 0xBF0C), isNotNull);
      expect(findTag(tlvs, 0x9F38)!.value, bytes('9F6604'));
      expect(findTag(tlvs, 0x5A), isNull);

      expect(parseTlv(bytes('DF8101 01 AA')).single.tag, 0xDF8101);
    });

    test('reads 0x81 and 0x82 lengths', () {
      final long = parseTlv(bytes('50 81 80 ${'AB' * 128}'));
      expect(long.single.value, hasLength(128));

      final longer = parseTlv(bytes('9F10 82 0100 ${'CD' * 256} 5A 01 12'));
      expect(longer, hasLength(2));
      expect(longer.first.value, hasLength(256));
      expect(longer.last.value, [0x12]);
    });

    test('skips 00 and FF padding', () {
      final tlvs = parseTlv(bytes('00 00 5A 02 1234 00 00 FF FF'));
      expect(tlvs.single.tag, 0x5A);
      expect(tlvs.single.value, [0x12, 0x34]);
    });

    test('returns what parsed on malformed input instead of throwing', () {
      expect(parseTlv(Uint8List(0)), isEmpty);
      expect(parseTlv(bytes('5A 08 1234')), isEmpty); // value runs past the end
      expect(parseTlv(bytes('5A 02 1234 9F')).single.tag, 0x5A); // dangling multi-byte tag
      expect(parseTlv(bytes('5A 02 1234 9F38')).single.tag, 0x5A); // tag without a length
      expect(parseTlv(bytes('50 84 00000001 AA')), isEmpty); // 4-byte length
      expect(parseTlv(bytes('9F 81 81 81 81 01 00')), isEmpty); // tag longer than 4 bytes
      final broken = parseTlv(bytes('70 03 5A 05 12')).single; // bad contents in a good template
      expect(broken.tag, 0x70);
      expect(broken.children, isEmpty);

      final random = Random(7);
      for (var run = 0; run < 500; run++) {
        final junk = Uint8List.fromList(List.generate(random.nextInt(64), (_) => random.nextInt(256)));
        expect(() => parseTlv(junk), returnsNormally);
      }
    });

    test('toString never shows the value', () {
      final pan = parseTlv(bytes('5A 08 4111111111111111')).single;
      expect(pan.toString(), 'Tlv(5A, 8 bytes)');
    });
  });

  group('readEmvCard', () {
    test('Visa-like card: PDOL, then the PAN from track 2 in the GPO response', () async {
      const gpo = '80A80000 10 83 0E 36004000 000000000000 A5A5A5A5 00';
      final card = FakeCard({
        ppse: ok(ppseFci([entry(visaAid, label: 'VISA CREDIT', priority: 1)])),
        select(visaAid): ok(appFci(visaAid, 'VISA CREDIT', pdol: '9F6604 9F0206 9F3704')),
        gpo: ok(tlv('77', tlv('82', '2000') + tlv('94', '08010100') + tlv('57', '4111111111111111D28122010000000F'))),
      });

      final id = await read(card);

      expect(id!.pan, '4111111111111111');
      expect(id.last4, '1111');
      // The PAN came with the GPO response, so no records are read.
      expect(card.sent, commands([ppse, select(visaAid), gpo]));
    });

    test('Mastercard-like card: no PDOL, AFL in format 1, PAN from a record', () async {
      final card = FakeCard({
        ppse: ok(ppseFci([entry(mcAid, label: 'MASTERCARD', priority: 1)])),
        select(mcAid): ok(appFci(mcAid, 'MASTERCARD')),
        gpoNoPdol: ok(tlv('80', '1980 08010100')),
        readRecord(1, 1): ok(
          '${tlv('70', tlv('5F24', '301231') + tlv('5A', '5413330089020037') + tlv('5F34', '01'))}0000',
        ),
      });

      final id = await read(card);

      expect(id!.pan, '5413330089020037');
      expect(id.last4, '0037');
      expect(card.sent, commands([ppse, select(mcAid), gpoNoPdol, '00B2010C00']));
    });

    test('fills every PDOL field the card asks for', () async {
      const pdol = '9F6604 9F0206 9F0306 9F1A02 9505 5F2A02 9A03 9C01 9F3704 DF6002';
      const data = '36004000 000000000000 000000000000 0356 0000000000 0356 261114 00 A5A5A5A5 0000';
      const gpo = '80A80000 25 83 23 $data 00';
      final card = FakeCard({
        ppse: ok(ppseFci([entry(visaAid)])),
        select(visaAid): ok(appFci(visaAid, 'VISA', pdol: pdol)),
        gpo: ok(tlv('77', tlv('82', '2000') + tlv('5A', '4000000000000002'))),
      });

      expect((await read(card))!.pan, '4000000000000002');
      expect(card.sent.last, _clean(gpo));
    });

    test('resends with the right Le on 6C xx', () async {
      final ppseData = ppseFci([entry(mcAid, priority: 1)]);
      final record = tlv('70', tlv('5A', '5413330089020037'));
      final ppseRetry = '00A404000E 325041592E5359532E4444463031 ${lengthOf(ppseData)}';
      final recordRetry = '00B2010C${lengthOf(record)}';
      final card = FakeCard({
        ppse: '6C${lengthOf(ppseData)}',
        ppseRetry: ok(ppseData),
        select(mcAid): ok(appFci(mcAid, 'MASTERCARD')),
        gpoNoPdol: ok(tlv('80', '1980 08010100')),
        readRecord(1, 1): '6C${lengthOf(record)}',
        recordRetry: ok(record),
      });

      expect((await read(card))!.pan, '5413330089020037');
      expect(card.sent, commands([ppse, ppseRetry, select(mcAid), gpoNoPdol, readRecord(1, 1), recordRetry]));
    });

    test('fetches the rest with GET RESPONSE on 61 xx', () async {
      final fci = appFci(mcAid, 'MASTERCARD');
      final gpoData = tlv('80', '1980 08010100');
      final card = FakeCard({
        ppse: ok(ppseFci([entry(mcAid)])),
        select(mcAid): '61${lengthOf(fci)}',
        '00C00000${lengthOf(fci)}': ok(fci),
        gpoNoPdol: '61${lengthOf(gpoData)}',
        '00C00000${lengthOf(gpoData)}': ok(gpoData),
        readRecord(1, 1): ok(tlv('70', tlv('5A', '5413330089020037'))),
      });

      expect((await read(card))!.pan, '5413330089020037');
      expect(
        card.sent,
        commands([
          ppse,
          select(mcAid),
          '00C00000${lengthOf(fci)}',
          gpoNoPdol,
          '00C00000${lengthOf(gpoData)}',
          readRecord(1, 1),
        ]),
      );
    });

    test('tries the highest-priority AID first and moves on when it fails', () async {
      final card = FakeCard({
        ppse: ok(ppseFci([entry(electronAid, priority: 2), entry(visaAid, priority: 1)])),
        select(visaAid): '6A82',
        select(electronAid): ok(appFci(electronAid, 'VISA ELECTRON')),
        gpoNoPdol: ok(tlv('77', tlv('57', '4111111111111111D28122010000000F'))),
      });

      expect((await read(card))!.pan, '4111111111111111');
      expect(card.sent, commands([ppse, select(visaAid), select(electronAid), gpoNoPdol]));
    });

    test('falls back to the PSE directory and reads every AFL entry', () async {
      final card = FakeCard({
        ppse: '6A82',
        pse: ok(tlv('6F', tlv('84', ascii('1PAY.SYS.DDF01')) + tlv('A5', tlv('88', '02') + tlv('5F2D', ascii('en'))))),
        readRecord(2, 1): ok(tlv('70', entry(amexAid, label: 'AMEX', priority: 1))),
        readRecord(2, 2): '6A83',
        select(amexAid): ok(appFci(amexAid, 'AMEX')),
        gpoNoPdol: ok(tlv('77', tlv('82', '1800') + tlv('94', '08010200 18010100'))),
        readRecord(1, 1): ok(tlv('70', tlv('5F24', '301231') + tlv('9F07', 'FF00'))),
        readRecord(1, 2): '6A83',
        readRecord(3, 1): ok(tlv('70', tlv('5A', '378282246310005F'))), // 15 digits, F-padded
      });

      final id = await read(card);

      expect(id!.pan, '378282246310005');
      expect(id.last4, '0005');
      expect(
        card.sent,
        commands([
          ppse,
          pse,
          readRecord(2, 1),
          readRecord(2, 2),
          select(amexAid),
          gpoNoPdol,
          readRecord(1, 1),
          readRecord(1, 2),
          readRecord(3, 1),
        ]),
      );
    });

    test('prefers a PAN that passes the Luhn check, else keeps the first one seen', () async {
      Map<String, String> card(String secondRecord) => {
        ppse: ok(ppseFci([entry(mcAid)])),
        select(mcAid): ok(appFci(mcAid, 'MASTERCARD')),
        gpoNoPdol: ok(tlv('80', '1980 08010200')),
        readRecord(1, 1): ok(tlv('70', tlv('5A', '5413330089020039'))), // fails Luhn
        readRecord(1, 2): secondRecord,
      };

      final valid = await read(FakeCard(card(ok(tlv('70', tlv('57', '5413330089020037D30122010000000F'))))));
      expect(valid!.pan, '5413330089020037');

      final onlyInvalid = await read(FakeCard(card('6A83')));
      expect(onlyInvalid!.pan, '5413330089020039');
    });

    test('returns null when neither PPSE nor PSE is there', () async {
      final card = FakeCard({ppse: '6A82', pse: '6A82'});

      expect(await read(card), isNull);
      expect(card.sent, commands([ppse, pse]));
    });

    test('returns null when the card gives no PAN', () async {
      final card = FakeCard({
        ppse: ok(ppseFci([entry(mcAid)])),
        select(mcAid): ok(appFci(mcAid, 'MASTERCARD')),
        gpoNoPdol: '6985',
      });

      expect(await read(card), isNull);
      expect(card.sent, commands([ppse, select(mcAid), gpoNoPdol]));
    });

    test('returns null when transceive throws or answers garbage', () async {
      expect(await readEmvCard((_) async => throw Exception('Tag was lost')), isNull);
      expect(await readEmvCard((_) => throw StateError('NFC off')), isNull);
      expect(await readEmvCard((_) async => Uint8List.fromList([0x90])), isNull);

      final card = FakeCard({
        ppse: ok(ppseFci([entry(mcAid)])),
      });
      Future<Uint8List> dropsAfterPpse(Uint8List command) =>
          card.sent.isEmpty ? card.call(command) : throw Exception('Tag was lost');
      expect(await readEmvCard(dropsAfterPpse), isNull);
    });
  });

  test('EmvCardId.toString hides the PAN', () {
    final id = EmvCardId('4111111111111111');

    expect(id.last4, '1111');
    expect(id.toString(), 'EmvCardId(•••• 1111)');
    expect('$id', isNot(contains('411111')));
  });
}
