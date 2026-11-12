import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:globalpay/domain/models/money.dart';
import 'package:globalpay/domain/models/promptpay_qr.dart';
import 'package:globalpay/domain/promptpay/promptpay_parser.dart';

/// The same vectors the backend tests against (services/api/test/promptpay.test.ts).
final vectors =
    jsonDecode(File('../../packages/fixtures/promptpay/vectors.json').readAsStringSync()) as Map<String, dynamic>;

PromptPayError errorOf(String payload) {
  try {
    parsePromptPayQr(payload);
  } on PromptPayParseException catch (e) {
    return e.error;
  }
  fail('expected $payload to be rejected');
}

/// Rebuilds a payload with a correct CRC, so a test reaches the check it targets.
String withCrc(String body) => '${body}6304${crc16('${body}6304')}';

void main() {
  group('shared vectors', () {
    for (final vector in (vectors['valid'] as List).cast<Map<String, dynamic>>()) {
      test('parses ${vector['name']}', () {
        final qr = parsePromptPayQr(vector['payload'] as String);
        final expected = vector['expected'] as Map<String, dynamic>;

        expect(qr.raw, vector['payload']);
        expect(qr.isDynamic, expected['initiation'] == 'dynamic');
        expect(qr.kind.name, expected['kind']);
        expect(qr.targetType.name, expected['targetType']);
        expect(qr.targetId, expected['targetId']);
        expect(qr.reference1, expected['reference1']);
        expect(qr.reference2, expected['reference2']);
        expect(qr.merchantName, expected['merchantName']);
        expect(qr.merchantCity, expected['merchantCity']);
        expect(qr.amount == null ? null : formatMinorUnits(qr.amount!.minor, 2), expected['amount']);
      });
    }

    for (final vector in (vectors['invalid'] as List).cast<Map<String, dynamic>>()) {
      test('rejects ${vector['name']}', () {
        expect(errorOf(vector['payload'] as String).code, vector['error']);
      });
    }

    test('covers every error code', () {
      final codes = (vectors['invalid'] as List).map((v) => (v as Map)['error']).toSet();
      expect(codes, PromptPayError.values.map((e) => e.code).toSet());
    });
  });

  group('edge cases', () {
    const mobile = '29370016A00000067701011101130066812345678';

    test('accepts whitespace, a lowercase CRC and short amounts', () {
      final payload = withCrc('000201010212${mobile}530376454045.505802TH');
      final lower = payload.substring(0, payload.length - 4) + payload.substring(payload.length - 4).toLowerCase();
      final qr = parsePromptPayQr('  $lower\n');
      expect(qr.amount?.minor, BigInt.from(550));
      expect(qr.kind, PromptPayKind.personal);
    });

    test('infers initiation from the amount when tag 01 is missing', () {
      expect(parsePromptPayQr(withCrc('000201${mobile}5303764540510.005802TH')).isDynamic, isTrue);
      expect(parsePromptPayQr(withCrc('000201${mobile}53037645802TH')).isDynamic, isFalse);
    });

    test('rejects bad field values as invalid_field', () {
      for (final body in [
        '000201010212${mobile}530376454040.005802TH', // zero amount
        '000201010212${mobile}530376454051.0005802TH', // three decimals
        '000201010213${mobile}53037645802TH', // unknown initiation
        '000201010211${mobile}53037645802US', // wrong country
        '000201010211${'29360016A0000006770101110112006681234567'}53037645802TH', // short mobile
      ]) {
        expect(errorOf(withCrc(body)), PromptPayError.invalidField, reason: body);
      }
    });

    test('rejects a repeated tag as malformed', () {
      expect(errorOf(withCrc('000201010211${mobile}530376453037645802TH')), PromptPayError.malformedTlv);
    });
  });

  test('computes the CRC-16/CCITT-FALSE check value', () {
    expect(crc16('123456789'), '29B1');
  });
}
