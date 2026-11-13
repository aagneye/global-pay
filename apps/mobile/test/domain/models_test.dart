import 'package:flutter_test/flutter_test.dart';
import 'package:globalpay/data/repositories/payments_repository.dart' show thb, usdc;
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
      expect(TokenAmount(symbol: 'USDC', units: BigInt.from(7123456), decimals: 6).format(), '7.123456 USDC');
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

  group('Payout', () {
    Payment payment(PaymentStatus status, Payout? payout) => Payment(
      id: 'p1',
      quoteId: '0x01',
      status: status,
      fiatAmount: thb('25000'),
      tokenAmount: usdc('7477454'),
      merchantName: 'Cafe',
      createdAt: DateTime(2026, 11, 13),
      payout: payout,
    );

    test('maps backend names, and treats a new one as unknown', () {
      expect(PayoutStatus.fromApi('SUCCEEDED'), PayoutStatus.succeeded);
      expect(PayoutStatus.fromApi('REVERSED'), PayoutStatus.reversed);
      expect(PayoutStatus.fromApi('SOMETHING_NEW'), PayoutStatus.unknown);
      expect(PayoutStatus.fromApi(null), PayoutStatus.unknown);
    });

    test('labels an unclear or reversed payout "Needs review"', () {
      const unclear = Payout(status: PayoutStatus.unknown, provider: 'xendit');
      const reversed = Payout(status: PayoutStatus.reversed, provider: 'xendit');
      const paid = Payout(status: PayoutStatus.succeeded, provider: 'xendit', reference: 'BANK-1');
      expect(payment(PaymentStatus.payoutPending, unclear).statusLabel, 'Needs review');
      expect(payment(PaymentStatus.settled, reversed).statusLabel, 'Needs review');
      expect(payment(PaymentStatus.settled, paid).statusLabel, 'Merchant paid');
      expect(payment(PaymentStatus.paid, null).statusLabel, 'Received');
    });
  });
}
