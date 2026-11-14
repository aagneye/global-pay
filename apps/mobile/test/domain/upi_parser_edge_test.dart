import 'package:flutter_test/flutter_test.dart';
import 'package:globalpay/domain/upi/upi_parser.dart';

/// The message a refused payload gets, so a test can check it says what's wrong.
String refusal(String payload) {
  try {
    parseUpiQr(payload);
  } on UpiParseException catch (e) {
    return e.message;
  }
  fail('expected $payload to be refused');
}

void main() {
  group('UPI scheme and host', () {
    test('accept any mix of case', () {
      for (final prefix in ['upi://pay', 'UPI://PAY', 'Upi://Pay', 'uPi://pAy']) {
        expect(parseUpiQr('$prefix?pa=shop@paytm').vpa, 'shop@paytm', reason: prefix);
      }
    });

    final notUpi = <String, String>{
      'an empty string': '',
      'only whitespace': '  \n\t ',
      'a collect request': 'upi://collect?pa=shop@paytm',
      'a look-alike host': 'upi://pay.evil.example?pa=shop@paytm',
      'no // after the scheme': 'upi:pay?pa=shop@paytm',
      'another scheme': 'upix://pay?pa=shop@paytm',
      'a GlobalPay request link': 'globalpay://pay?r=request_1&c=0x${'ab' * 32}',
      'a web link with a UPI-looking path': 'https://example.com/upi://pay?pa=shop@paytm',
      'plain text': 'pay shop@paytm 100 rupees',
    };
    for (final MapEntry(key: name, value: payload) in notUpi.entries) {
      test('refuse $name as not a UPI QR', () {
        expect(refusal(payload), 'This is not a UPI payment QR.');
      });
    }

    test('refuse a UPI link with no query at all: it has no pa', () {
      expect(refusal('upi://pay'), contains('no UPI ID (pa)'));
      expect(refusal('upi://pay?'), contains('no UPI ID (pa)'));
    });
  });

  group('pa (the UPI ID)', () {
    test('is required, and blank counts as missing', () {
      expect(refusal('upi://pay?pa=%20%20&am=10'), contains('no UPI ID (pa)'));
      expect(refusal('upi://pay?pa=+&am=10'), contains('no UPI ID (pa)'));
      expect(refusal('upi://pay?pa'), contains('no UPI ID (pa)'));
    });

    test('is matched by its exact key: PA or Pa is not pa', () {
      expect(refusal('upi://pay?PA=shop@paytm'), contains('no UPI ID (pa)'));
    });

    test('is trimmed before it is checked', () {
      expect(parseUpiQr('upi://pay?pa=%20shop@paytm%20').vpa, 'shop@paytm');
    });

    test('accepts the edges of the pattern: 2 and 256 characters before @, 2 and 64 in the handle', () {
      expect(parseUpiQr('upi://pay?pa=ab@ok').vpa, 'ab@ok');
      final longName = 'a' * 256;
      final longHandle = 'h${'1' * 63}';
      expect(parseUpiQr('upi://pay?pa=$longName@$longHandle').vpa, '$longName@$longHandle');
      expect(parseUpiQr('upi://pay?pa=Ravi.Kumar_9-x@OkSBI').vpa, 'Ravi.Kumar_9-x@OkSBI');
    });

    final badVpas = <String, String>{
      'one character before @': 'a@paytm',
      '257 characters before @': '${'a' * 257}@paytm',
      'a one-letter handle': 'shop@p',
      'a 65-character handle': 'shop@h${'1' * 64}',
      'two @': 'shop@pay@tm',
      'nothing before @': '@paytm',
      'nothing after @': 'shop@',
      'a dot in the handle': 'shop@pay.tm',
      'a hyphen in the handle': 'shop@pay-tm',
      'a plus before @': 'shop%2Bx@paytm',
      'non-ASCII letters': 'd%C3%BCkkan@paytm',
      'an email address': 'shop@gmail.com',
    };
    for (final MapEntry(key: name, value: vpa) in badVpas.entries) {
      test('refuses $name', () {
        expect(refusal('upi://pay?pa=$vpa&am=10'), endsWith('is not a valid UPI ID.'), reason: vpa);
      });
    }
  });

  group('cu (the currency)', () {
    test('accepts INR in any case and with spaces around it', () {
      for (final cu in ['INR', 'inr', 'Inr', '%20INR%20', '']) {
        expect(parseUpiQr('upi://pay?pa=shop@paytm&am=10&cu=$cu').amount!.minor, BigInt.from(1000), reason: cu);
      }
    });

    test('refuses USD, lowercase usd and any other currency, naming it', () {
      expect(refusal('upi://pay?pa=shop@paytm&am=10&cu=USD'), 'This UPI QR is in USD. Only rupees (INR) are supported.');
      expect(refusal('upi://pay?pa=shop@paytm&am=10&cu=usd'), contains('in usd.'));
      for (final cu in ['THB', 'INRX', 'IN', '356']) {
        expect(refusal('upi://pay?pa=shop@paytm&cu=$cu'), contains('Only rupees (INR)'), reason: cu);
      }
    });

    test('is checked even when the QR has no amount', () {
      expect(refusal('upi://pay?pa=shop@paytm&cu=USD'), contains('in USD'));
    });
  });

  group('am (the amount)', () {
    test('converts rupees to paise exactly', () {
      final cases = {
        '1': 100,
        '0.01': 1,
        '0.1': 10,
        '00010.50': 1050,
        '100000.00': 10000000,
        '9999999.99': 999999999,
      };
      for (final MapEntry(key: am, value: paise) in cases.entries) {
        expect(parseUpiQr('upi://pay?pa=shop@paytm&am=$am').amount!.minor, BigInt.from(paise), reason: am);
      }
    });

    test('keeps a huge amount exact (no floating point)', () {
      expect(
        parseUpiQr('upi://pay?pa=shop@paytm&am=123456789012345678901.23').amount!.minor,
        BigInt.parse('12345678901234567890123'),
      );
    });

    test('is trimmed: a space-padded (or +-padded) amount is read as the number', () {
      expect(parseUpiQr('upi://pay?pa=shop@paytm&am=%20250%20').amount!.minor, BigInt.from(25000));
      // `+` decodes to a space in a query, so "+250" is " 250", the same as the backend reads it.
      expect(parseUpiQr('upi://pay?pa=shop@paytm&am=+250').amount!.minor, BigInt.from(25000));
    });

    test('a blank amount (only spaces) means the payer types it', () {
      expect(parseUpiQr('upi://pay?pa=shop@paytm&am=%20').amount, isNull);
    });

    test('refuses zero however it is written, with a clear message', () {
      for (final am in ['0', '0.0', '00.00', '0.00']) {
        expect(refusal('upi://pay?pa=shop@paytm&am=$am'), 'The amount must be more than ₹0.', reason: am);
      }
    });

    final badAmounts = <String, String>{
      'three decimals': '1.001',
      'three zero decimals': '100.000',
      'a negative amount': '-1',
      'negative zero': '-0',
      'a leading dot': '.50',
      'a trailing dot': '10.',
      'an explicit plus sign': '%2B10',
      'an exponent': '1e3',
      'a comma decimal': '10,50',
      'a rupee sign': '%E2%82%B9100',
      'a currency code': '100INR',
      'two dots': '1.2.3',
      'an inner space': '1%2000',
      'Infinity': 'Infinity',
      'NaN': 'NaN',
      'hex': '0x10',
      'Devanagari digits': '%E0%A5%A7%E0%A5%A6',
    };
    for (final MapEntry(key: name, value: am) in badAmounts.entries) {
      test('refuses $name', () {
        expect(refusal('upi://pay?pa=shop@paytm&am=$am'), endsWith('is not a valid amount.'), reason: am);
      });
    }
  });

  group('pn and the other text fields', () {
    test('decode + and %20 as spaces, and %2B as a literal plus', () {
      expect(parseUpiQr('upi://pay?pa=shop@paytm&pn=Chai+Point').name, 'Chai Point');
      expect(parseUpiQr('upi://pay?pa=shop@paytm&pn=Chai%20Point').name, 'Chai Point');
      expect(parseUpiQr('upi://pay?pa=shop@paytm&pn=A%2BB+Stores').name, 'A+B Stores');
    });

    test('decode reserved characters and non-Latin names', () {
      expect(parseUpiQr('upi://pay?pa=shop@paytm&pn=Tom%20%26%20Jerry%3D1').name, 'Tom & Jerry=1');
      expect(
        parseUpiQr('upi://pay?pa=shop@paytm&pn=%E0%A4%9A%E0%A4%BE%E0%A4%AF%20%E0%A4%B5%E0%A4%BE%E0%A4%B2%E0%A4%BE').name,
        'चाय वाला',
      );
    });

    test('trim the name, and a blank name falls back to the UPI ID', () {
      expect(parseUpiQr('upi://pay?pa=shop@paytm&pn=++Chai++').name, 'Chai');
      final blank = parseUpiQr('upi://pay?pa=shop@paytm&pn=%20');
      expect(blank.name, isNull);
      expect(blank.payeeName, 'shop@paytm');
    });

    test('a blank mc is not a merchant, and a blank tr adds no reference', () {
      final qr = parseUpiQr('upi://pay?pa=shop@paytm&mc=&tr=%20&tn=');
      expect(qr.isMerchant, isFalse);
      expect(qr.merchantCode, isNull);
      expect(qr.reference, isNull);
      expect(qr.note, isNull);
      expect(qr.payeeDetail, 'shop@paytm');
    });

    test('a name that looks like a parameter stays inside the name', () {
      final qr = parseUpiQr('upi://pay?pa=shop@paytm&pn=x%26pa%3Dattacker%40ybl%26am%3D99999');
      expect(qr.vpa, 'shop@paytm');
      expect(qr.amount, isNull);
      expect(qr.name, 'x&pa=attacker@ybl&am=99999');
    });
  });

  group('parameters', () {
    test('ignores unknown and optional NPCI parameters', () {
      final qr = parseUpiQr(
        'upi://pay?ver=01&mode=02&purpose=00&orgid=159761&pa=shop@paytm&pn=Shop&mid=M1&msid=S1&mtid=T1'
        '&sign=MEUCIQDabc%2Bdef%3D&url=https%3A%2F%2Fshop.example&am=10&cu=INR&foo=bar&mam=5',
      );
      expect(qr.vpa, 'shop@paytm');
      expect(qr.name, 'Shop');
      expect(qr.amount!.minor, BigInt.from(1000));
      expect(qr.merchantCode, isNull);
    });

    test('accepts the parameters in any order', () {
      final qr = parseUpiQr('upi://pay?cu=INR&am=5.25&tr=R9&pn=Shop&mc=5411&pa=shop@paytm');
      expect(qr.vpa, 'shop@paytm');
      expect(qr.amount!.minor, BigInt.from(525));
      expect(qr.merchantCode, '5411');
      expect(qr.reference, 'R9');
    });

    test('ignores a fragment: it cannot change the amount', () {
      final qr = parseUpiQr('upi://pay?pa=shop@paytm&am=10#am=99999');
      expect(qr.amount!.minor, BigInt.from(1000));
    });

    test('tolerates empty pairs between parameters', () {
      expect(parseUpiQr('upi://pay?&&pa=shop@paytm&&am=10&').amount!.minor, BigInt.from(1000));
    });

    // The backend (services/api/src/lib/upi/parse.ts) keeps the FIRST value of a repeated parameter, so the
    // app must show that one too, or refuse the QR. Otherwise the confirm screen names one payee and the
    // backend pays another.
    test(
      'a repeated pa: shows the payee the backend pays (the first), or refuses the QR',
      () {
        const spoof = 'upi://pay?pa=attacker@ybl&pn=Chai%20Point&pa=chaipoint@okicici';
        UpiParseException? refused;
        String? shown;
        try {
          shown = parseUpiQr(spoof).vpa;
        } on UpiParseException catch (e) {
          refused = e;
        }
        expect(refused != null || shown == 'attacker@ybl', isTrue, reason: 'the app shows $shown');
      },
      skip:
          'BUG: Dart Uri.queryParameters keeps the LAST repeated pa, the backend keeps the FIRST: '
          'the confirm screen can show chaipoint@okicici while the backend pays attacker@ybl.',
    );

    test(
      'a repeated am: shows the amount the backend quotes (the first), or refuses the QR',
      () {
        const twice = 'upi://pay?pa=shop@paytm&am=9999&am=10';
        UpiParseException? refused;
        BigInt? shown;
        try {
          shown = parseUpiQr(twice).amount?.minor;
        } on UpiParseException catch (e) {
          refused = e;
        }
        expect(refused != null || shown == BigInt.from(999900), isTrue, reason: 'the app shows $shown paise');
      },
      skip:
          'BUG: the app keeps the LAST repeated am (₹10), the backend the FIRST (₹9,999): the confirm screen '
          'shows a different amount from the one quoted.',
    );

    test(
      'an upper-case PA before pa: shows the payee the backend pays (PA, as it ignores key case), or refuses',
      () {
        const spoof = 'upi://pay?PA=attacker@ybl&pa=chaipoint@okicici';
        UpiParseException? refused;
        String? shown;
        try {
          shown = parseUpiQr(spoof).vpa;
        } on UpiParseException catch (e) {
          refused = e;
        }
        expect(refused != null || shown == 'attacker@ybl', isTrue, reason: 'the app shows $shown');
      },
      skip:
          'BUG: the backend lower-cases parameter names (PA counts as pa, first wins), the app only reads '
          'lower-case pa: the confirm screen shows chaipoint@okicici while the backend pays attacker@ybl.',
    );

    test('documents today: a repeated parameter keeps the last value in the app', () {
      // Pins the current behaviour the two skipped tests above report, so a fix shows up here.
      expect(parseUpiQr('upi://pay?pa=one@paytm&pa=two@paytm').vpa, 'two@paytm');
      expect(parseUpiQr('upi://pay?pa=shop@paytm&am=1&am=2').amount!.minor, BigInt.from(200));
    });
  });

  group('whitespace and size', () {
    test('trims spaces, tabs, CRLF and newlines around the payload, and keeps raw trimmed', () {
      for (final pad in [' ', '\n', '\r\n', '\t', ' \r\n\t ']) {
        final qr = parseUpiQr('${pad}upi://pay?pa=shop@paytm&am=10$pad');
        expect(qr.raw, 'upi://pay?pa=shop@paytm&am=10', reason: pad.codeUnits.toString());
        expect(qr.amount!.minor, BigInt.from(1000));
      }
    });

    test('isUpiPayload agrees with the parser about padded payloads', () {
      expect(isUpiPayload('\r\n UPI://pay?pa=shop@paytm'), isTrue);
      expect(isUpiPayload(''), isFalse);
      expect(isUpiPayload('https://upi.example'), isFalse);
    });

    test('reads a very long payload (a 10,000-character note)', () {
      final note = 'n' * 10000;
      final qr = parseUpiQr('upi://pay?pa=shop@paytm&am=1&tn=$note');
      expect(qr.note, note);
      expect(qr.raw.length, greaterThan(10000));
    });

    test('refuses a very long UPI ID rather than accepting it', () {
      expect(refusal('upi://pay?pa=${'a' * 5000}@paytm'), endsWith('is not a valid UPI ID.'));
    });
  });
}
