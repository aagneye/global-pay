import 'package:flutter_test/flutter_test.dart';
import 'package:globalpay/domain/models/money.dart';
import 'package:globalpay/domain/upi/upi_parser.dart';

void main() {
  group('parseUpiQr', () {
    test('reads a dynamic merchant QR: VPA, decoded name, amount in paise, code and reference', () {
      final qr = parseUpiQr(
        '  upi://pay?pa=chaipoint@okicici&pn=Chai%20Point%20Bengaluru&am=250.00&cu=INR&mc=5812&tr=T1234&tn=Masala+chai\n',
      );
      expect(qr.vpa, 'chaipoint@okicici');
      expect(qr.name, 'Chai Point Bengaluru');
      expect(qr.amount!.currency, FiatCurrency.inr);
      expect(qr.amount!.minor, BigInt.from(25000));
      expect(qr.amount!.format(), '₹250.00');
      expect(qr.merchantCode, '5812');
      expect(qr.reference, 'T1234');
      expect(qr.note, 'Masala chai');
      expect(qr.isMerchant, isTrue);
      expect(qr.raw, startsWith('upi://pay?pa=chaipoint@okicici'));
      expect(qr.payeeName, 'Chai Point Bengaluru');
      expect(qr.payeeDetail, 'chaipoint@okicici · Ref T1234');
      expect(qr.currency, FiatCurrency.inr);
    });

    test('reads a static personal QR: no amount, no currency, no name', () {
      final qr = parseUpiQr('upi://pay?pa=ravi.kumar-1@ybl');
      expect(qr.amount, isNull);
      expect(qr.name, isNull);
      expect(qr.payeeName, 'ravi.kumar-1@ybl');
      expect(qr.isMerchant, isFalse);
    });

    test('accepts the scheme in any case, an empty am, and amounts with 0-2 decimals', () {
      expect(parseUpiQr('UPI://PAY?pa=shop@paytm&am=').amount, isNull);
      expect(parseUpiQr('upi://pay?pa=shop@paytm&am=99').amount!.minor, BigInt.from(9900));
      expect(parseUpiQr('upi://pay?pa=shop@paytm&am=0.5').amount!.minor, BigInt.from(50));
      expect(parseUpiQr('upi://pay?pa=shop@paytm&cu=inr').amount, isNull);
    });

    final refusals = <String, String>{
      'a PromptPay QR': '00020101021129370016A000000677010111011300668123456785802TH53037646304ABCD',
      'a web link': 'https://pay.example/upi?pa=shop@paytm',
      'another UPI action': 'upi://mandate?pa=shop@paytm',
      'no pa': 'upi://pay?pn=Shop&am=10',
      'an empty pa': 'upi://pay?pa=&am=10',
      'a pa without @': 'upi://pay?pa=shoppaytm',
      'a pa with a bad handle': 'upi://pay?pa=shop@1paytm',
      'a pa with spaces': 'upi://pay?pa=sh%20op@paytm',
      'another currency': 'upi://pay?pa=shop@paytm&am=10&cu=USD',
      'three decimals': 'upi://pay?pa=shop@paytm&am=10.505',
      'a negative amount': 'upi://pay?pa=shop@paytm&am=-10',
      'a zero amount': 'upi://pay?pa=shop@paytm&am=0.00',
      'a comma amount': 'upi://pay?pa=shop@paytm&am=1,000',
      'bad percent-encoding': 'upi://pay?pa=shop@paytm&pn=%E0%A4',
    };
    for (final MapEntry(key: name, value: payload) in refusals.entries) {
      test('refuses $name', () {
        expect(() => parseUpiQr(payload), throwsA(isA<UpiParseException>()), reason: payload);
      });
    }

    test('tells UPI payloads from PromptPay', () {
      expect(isUpiPayload(' upi://pay?pa=a@b'), isTrue);
      expect(isUpiPayload('UPI://pay'), isTrue);
      expect(isUpiPayload('000201010211'), isFalse);
    });
  });
}
