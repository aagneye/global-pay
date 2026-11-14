import 'package:flutter_test/flutter_test.dart';
import 'package:globalpay/domain/models/promptpay_qr.dart';
import 'package:globalpay/domain/promptpay/promptpay_parser.dart';

PromptPayError errorOf(String payload) {
  try {
    parsePromptPayQr(payload);
  } on PromptPayParseException catch (e) {
    return e.error;
  }
  fail('expected $payload to be rejected');
}

/// Appends "6304" and the right CRC, so a test reaches the check it targets.
String withCrc(String body) => '${body}6304${crc16('${body}6304')}';

/// One TLV field, with its length counted in characters (code points).
String tlv(String tag, String value) => '$tag${value.runes.length.toString().padLeft(2, '0')}$value';

const personalAid = 'A000000677010111';
const merchantAid = 'A000000677010112';
const mobileId = '0066812345678';
const nationalId = '1234567890123';
const walletId = '123456789012345';
const billerId = '099999999999990';

String personal(Map<String, String> fields) => tlv('29', [for (final e in fields.entries) tlv(e.key, e.value)].join());
String merchant(Map<String, String> fields) => tlv('30', [for (final e in fields.entries) tlv(e.key, e.value)].join());

final toMobile = personal({'00': personalAid, '01': mobileId});

/// A whole payload: format 01, [initiation], the payee, THB, TH, plus [extra] fields before the CRC.
String payload({String? initiation = '11', String? payee, String currency = '764', String? amount, String extra = ''}) =>
    withCrc(
      [
        tlv('00', '01'),
        if (initiation != null) tlv('01', initiation),
        payee ?? toMobile,
        tlv('53', currency),
        if (amount != null) tlv('54', amount),
        tlv('58', 'TH'),
        extra,
      ].join(),
    );

/// The fixture QR: dynamic, 250.00 THB, GLOBALPAY TEST CAFE (packages/fixtures/promptpay).
const qr250 =
    '00020101021230600016A00000067701011201150999999999999010207INV00010306TABLE753037645406250.005802TH'
    '5919GLOBALPAY TEST CAFE6007BANGKOK6304E9FD';

void main() {
  test('the helpers build a payload the parser accepts', () {
    final qr = parsePromptPayQr(payload());
    expect(qr.kind, PromptPayKind.personal);
    expect(qr.targetType, PromptPayTargetType.mobile);
    expect(qr.targetId, mobileId);
    expect(qr.isDynamic, isFalse);
    expect(parsePromptPayQr(qr250).amount!.minor, BigInt.from(25000));
  });

  group('checksum', () {
    test('a changed digit in the body with the old CRC is a mismatch', () {
      final tampered = qr250.replaceFirst('250.00', '950.00');
      expect(errorOf(tampered), PromptPayError.crcMismatch);
    });

    test('a changed CRC digit is a mismatch', () {
      expect(errorOf('${qr250.substring(0, qr250.length - 1)}E'), PromptPayError.crcMismatch);
    });

    test('a CRC that is not hex is a mismatch', () {
      expect(errorOf('${qr250.substring(0, qr250.length - 4)}ZZZZ'), PromptPayError.crcMismatch);
    });

    test('a CRC with a CRC tag of the wrong length (6305) counts as missing', () {
      final body = qr250.substring(0, qr250.length - 8);
      expect(errorOf('${body}6305${crc16('${body}6305')}'), PromptPayError.missingCrc);
    });

    test('anything shorter than a CRC field counts as missing', () {
      for (final short in ['', ' ', '6304', '6304ABC', '\n']) {
        expect(errorOf(short), PromptPayError.missingCrc, reason: short);
      }
    });

    test('is checked first: a bad CRC wins over a bad currency or a bad TLV', () {
      final usd = payload(currency: '840');
      expect(errorOf('${usd.substring(0, usd.length - 4)}0000'), PromptPayError.crcMismatch);
      expect(errorOf('00029'), PromptPayError.missingCrc);
    });
  });

  group('truncated or malformed TLV', () {
    test('a fixture cut short loses its CRC', () {
      for (final cut in [1, 4, 8, 20, qr250.length - 9]) {
        expect(errorOf(qr250.substring(0, qr250.length - cut)), PromptPayError.missingCrc, reason: 'cut $cut');
      }
    });

    test('a field whose length runs past the end (re-checksummed) is malformed', () {
      expect(errorOf(withCrc('00020101021129370016$personalAid')), PromptPayError.malformedTlv);
    });

    test('a dangling half field before the CRC is malformed', () {
      expect(errorOf(withCrc('000201010211${toMobile}53037645802TH5')), PromptPayError.malformedTlv);
    });

    test('a zero-length field is malformed', () {
      expect(errorOf(withCrc('000201010211${toMobile}530376454005802TH')), PromptPayError.malformedTlv);
    });

    test('a non-numeric tag or length is malformed', () {
      expect(errorOf(withCrc('000201010211${toMobile}5303764AB02xy5802TH')), PromptPayError.malformedTlv);
      expect(errorOf(withCrc('000201010211${toMobile}53XX7645802TH')), PromptPayError.malformedTlv);
    });

    test('a CRC hidden inside another field (so it is not the last field) is malformed', () {
      // Tag 62 claims 12 characters: "ABCD" plus the 8 characters of the CRC field.
      final head = '000201010211${toMobile}53037645802TH6212ABCD';
      final crc = crc16('${head}6304');
      expect(errorOf('${head}6304$crc'), PromptPayError.malformedTlv);
    });

    test('malformed fields inside the payee (tag 29 or 30) are malformed', () {
      final badInner = tlv('29', '0016${personalAid}01990066812345678');
      expect(errorOf(payload(payee: badInner)), PromptPayError.malformedTlv);
      final repeatedInner = personal({'00': personalAid, '01': mobileId}).replaceFirst(
        tlv('01', mobileId),
        '${tlv('01', mobileId)}${tlv('01', mobileId)}',
      );
      // Rebuild the outer length after doubling the inner field.
      final inner = repeatedInner.substring(4);
      expect(errorOf(payload(payee: tlv('29', inner))), PromptPayError.malformedTlv);
    });
  });

  group('PromptPay and currency', () {
    test('an unknown AID in tag 29 is not PromptPay', () {
      expect(errorOf(payload(payee: personal({'00': 'A000000677010199', '01': mobileId}))), PromptPayError.notPromptPay);
    });

    test('a lowercase AID is not PromptPay', () {
      expect(
        errorOf(payload(payee: personal({'00': personalAid.toLowerCase(), '01': mobileId}))),
        PromptPayError.notPromptPay,
      );
    });

    test('the personal AID inside tag 30 (or the merchant AID in 29) is not PromptPay', () {
      expect(errorOf(payload(payee: merchant({'00': personalAid, '01': billerId}))), PromptPayError.notPromptPay);
      expect(errorOf(payload(payee: personal({'00': merchantAid, '01': mobileId}))), PromptPayError.notPromptPay);
    });

    test('rupees, an alphabetic code or a missing currency are unsupported', () {
      expect(errorOf(payload(currency: '356')), PromptPayError.unsupportedCurrency);
      expect(errorOf(payload(currency: 'THB')), PromptPayError.unsupportedCurrency);
      expect(errorOf(withCrc('000201010211${toMobile}5802TH')), PromptPayError.unsupportedCurrency);
    });

    test('the currency is checked before the field values', () {
      expect(errorOf(payload(currency: '840', amount: '-1')), PromptPayError.unsupportedCurrency);
    });
  });

  group('payee', () {
    test('reads a national ID and an e-wallet target', () {
      final id = parsePromptPayQr(payload(payee: personal({'00': personalAid, '02': nationalId})));
      expect(id.targetType, PromptPayTargetType.nationalId);
      expect(id.targetId, nationalId);
      final wallet = parsePromptPayQr(payload(payee: personal({'00': personalAid, '03': walletId})));
      expect(wallet.targetType, PromptPayTargetType.eWallet);
      expect(wallet.targetId, walletId);
    });

    test('refuses two targets, or none', () {
      expect(
        errorOf(payload(payee: personal({'00': personalAid, '01': mobileId, '02': nationalId}))),
        PromptPayError.invalidField,
      );
      expect(errorOf(payload(payee: personal({'00': personalAid}))), PromptPayError.invalidField);
    });

    test('refuses target IDs of the wrong length or with non-digits', () {
      for (final payee in [
        personal({'00': personalAid, '01': '006681234567'}),
        personal({'00': personalAid, '01': '00668123456789'}),
        personal({'00': personalAid, '01': '006681234567X'}),
        personal({'00': personalAid, '02': '123456789012'}),
        personal({'00': personalAid, '03': '12345678901234'}),
        merchant({'00': merchantAid, '01': '09999999999999'}),
        merchant({'00': merchantAid, '01': '09999999999999A'}),
        merchant({'00': merchantAid}),
      ]) {
        expect(errorOf(payload(payee: payee)), PromptPayError.invalidField, reason: payee);
      }
    });

    test('refuses a QR naming both a personal and a merchant payee', () {
      final both = '$toMobile${merchant({'00': merchantAid, '01': billerId})}';
      expect(errorOf(payload(payee: both)), PromptPayError.invalidField);
    });

    test('reads a merchant with references, and ignores unknown extra fields', () {
      final qr = parsePromptPayQr(
        payload(
          initiation: '12',
          payee: merchant({'00': merchantAid, '01': billerId, '02': 'INV1', '03': 'T7'}),
          amount: '12.34',
          extra: '${tlv('59', 'SHOP')}${tlv('60', 'CHIANG MAI')}${tlv('62', '0705T0001')}${tlv('99', 'x' * 99)}',
        ),
      );
      expect(qr.kind, PromptPayKind.merchant);
      expect(qr.reference1, 'INV1');
      expect(qr.reference2, 'T7');
      expect(qr.merchantName, 'SHOP');
      expect(qr.merchantCity, 'CHIANG MAI');
      expect(qr.amount!.minor, BigInt.from(1234));
      expect(qr.isMerchant, isTrue);
    });

    test('reads a Thai merchant name: lengths count characters, the CRC covers UTF-8 bytes', () {
      const name = 'ร้านกาแฟ';
      final qr = parsePromptPayQr(payload(extra: tlv('59', name)));
      expect(qr.merchantName, name);
      expect(qr.payeeName, name);
    });
  });

  group('format, country and initiation', () {
    test('refuses another payload format or a missing one', () {
      expect(errorOf(withCrc('000202010211${toMobile}53037645802TH')), PromptPayError.invalidField);
      expect(errorOf(withCrc('010211${toMobile}53037645802TH')), PromptPayError.invalidField);
    });

    test('refuses a missing or lowercase country', () {
      expect(errorOf(withCrc('000201010211${toMobile}5303764')), PromptPayError.invalidField);
      expect(errorOf(withCrc('000201010211${toMobile}53037645802th')), PromptPayError.invalidField);
    });

    test('a static QR (11) that carries an amount keeps the amount, so the payer cannot change it', () {
      final qr = parsePromptPayQr(payload(initiation: '11', amount: '40.00'));
      expect(qr.isDynamic, isFalse);
      expect(qr.amount!.minor, BigInt.from(4000));
    });

    test('a dynamic QR (12) without an amount leaves the amount to the payer', () {
      final qr = parsePromptPayQr(payload(initiation: '12'));
      expect(qr.isDynamic, isTrue);
      expect(qr.amount, isNull);
    });
  });

  group('amount (tag 54)', () {
    test('converts baht to satang exactly at the edges', () {
      final cases = {'0.01': 1, '1': 100, '1.5': 150, '0001.00': 100, '100000.00': 10000000, '9999999999': 999999999900};
      for (final MapEntry(key: amount, value: satang) in cases.entries) {
        expect(parsePromptPayQr(payload(amount: amount)).amount!.minor, BigInt.from(satang), reason: amount);
      }
    });

    test('refuses signs, spaces, exponents, commas, a bare dot and zero', () {
      for (final amount in ['-1', '+1', ' 1', '1 ', '1e2', '1,00', '.5', '5.', '0', '0.00', '1.234']) {
        expect(errorOf(payload(amount: amount)), PromptPayError.invalidField, reason: '"$amount"');
      }
    });
  });

  group('whitespace', () {
    test('trims CRLF, tabs and spaces around the payload, and keeps raw trimmed', () {
      final qr = parsePromptPayQr('\r\n\t $qr250 \t\r\n');
      expect(qr.raw, qr250);
    });

    test('a newline inside the payload breaks it', () {
      final broken = '${qr250.substring(0, 40)}\n${qr250.substring(40)}';
      expect(() => parsePromptPayQr(broken), throwsA(isA<PromptPayParseException>()));
    });
  });

  group('parseTlv', () {
    test('splits fields and refuses repeated tags', () {
      final fields = parseTlv('000201010211')!;
      expect([for (final f in fields) '${f.tag}=${f.value}'], ['00=01', '01=11']);
      expect(parseTlv('00020100021'), isNull);
      expect(parseTlv('0002010002'), isNull);
      expect(parseTlv(''), isEmpty);
    });
  });
}
