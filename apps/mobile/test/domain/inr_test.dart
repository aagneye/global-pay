import 'package:flutter_test/flutter_test.dart';
import 'package:globalpay/data/api/generated/export.dart' as dto;
import 'package:globalpay/data/repositories/payments_repository.dart';
import 'package:globalpay/domain/models/money.dart';

void main() {
  group('INR', () {
    test('formats paise with ₹, and THB stays ฿', () {
      expect(FiatAmount(currency: FiatCurrency.inr, minor: BigInt.from(25000)).format(), '₹250.00');
      expect(FiatAmount(currency: FiatCurrency.inr, minor: BigInt.from(5)).format(), '₹0.05');
      expect(FiatAmount(currency: FiatCurrency.thb, minor: BigInt.from(25000)).format(), '฿250.00');
    });

    test('finds the currency by its ISO code', () {
      expect(FiatCurrency.fromCode('INR'), FiatCurrency.inr);
      expect(FiatCurrency.fromCode('THB'), FiatCurrency.thb);
      expect(() => FiatCurrency.fromCode('USD'), throwsArgumentError);
    });

    test('formats a rateE8 to the paisa, rounding half up', () {
      expect(formatRateE8(BigInt.from(8352345678), FiatCurrency.inr), '₹83.52');
      expect(formatRateE8(BigInt.from(8352500000), FiatCurrency.inr), '₹83.53');
      expect(formatRateE8(BigInt.from(3376818073), FiatCurrency.thb), '฿33.77');
    });

    test('a UPI payment from the API shows rupees and the UPI ID', () {
      final payment = paymentFromDto(dto.Payment.fromJson(upiPaymentJson()));
      expect(payment.fiatAmount.format(), '₹250.00');
      expect(payment.merchantName, 'Chai Point');
      expect(payment.merchantId, 'chai@okicici');
      final unnamed = paymentFromDto(
        dto.Payment.fromJson(upiPaymentJson()..['merchant'] = {'kind': 'upi', 'targetId': 'chai@okicici'}),
      );
      expect(unnamed.merchantName, 'chai@okicici');
    });

    test('a THB payment still shows baht and the PromptPay fallback name', () {
      final json = upiPaymentJson()
        ..['fiatCurrency'] = 'THB'
        ..['merchant'] = {'kind': 'merchant', 'targetId': '0999'};
      final payment = paymentFromDto(dto.Payment.fromJson(json));
      expect(payment.fiatAmount.format(), '฿250.00');
      expect(payment.merchantName, 'PromptPay 0999');
    });
  });
}

Map<String, Object?> upiPaymentJson() {
  final now = DateTime.utc(2026, 11, 14).toIso8601String();
  return {
    'id': 'payment_1',
    'quoteId': '0x${'ab' * 32}',
    'status': 'SETTLED',
    'fiatCurrency': 'INR',
    'fiatAmount': '25000',
    'token': 'usdc.globalpay.testnet',
    'tokenAmount': '2994012',
    'merchant': {'kind': 'upi', 'targetId': 'chai@okicici', 'name': 'Chai Point'},
    'transactions': <String, Object?>{},
    'quoteExpiresAt': now,
    'createdAt': now,
    'updatedAt': now,
  };
}
