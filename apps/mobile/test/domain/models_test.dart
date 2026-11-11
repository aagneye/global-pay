import 'package:flutter_test/flutter_test.dart';
import 'package:globalpay/domain/models/money.dart';
import 'package:globalpay/domain/models/payment.dart';

void main() {
  group('formatMinorUnits', () {
    test('formats THB satang and USDC base units', () {
      expect(formatMinorUnits(BigInt.from(10050), 2), '100.50');
      expect(formatMinorUnits(BigInt.from(5), 2), '0.05');
      expect(formatMinorUnits(BigInt.from(2500000), 6), '2.500000');
      expect(formatMinorUnits(BigInt.from(-150), 2), '-1.50');
      expect(formatMinorUnits(BigInt.from(42), 0), '42');
    });

    test('formats amounts with symbols', () {
      expect(FiatAmount(currency: FiatCurrency.thb, minor: BigInt.from(25000)).format(), '฿250.00');
      expect(
        TokenAmount(symbol: 'USDC', units: BigInt.from(7123456), decimals: 6).format(),
        '7.123456 USDC',
      );
    });
  });

  group('PaymentStatus', () {
    test('maps backend names', () {
      expect(PaymentStatus.fromApi('PAYOUT_PENDING'), PaymentStatus.payoutPending);
      expect(() => PaymentStatus.fromApi('UNKNOWN'), throwsArgumentError);
    });

    test('knows terminal states', () {
      expect(PaymentStatus.settled.isTerminal, isTrue);
      expect(PaymentStatus.refunded.isTerminal, isTrue);
      expect(PaymentStatus.failed.isTerminal, isTrue);
      expect(PaymentStatus.paid.isTerminal, isFalse);
    });
  });
}
