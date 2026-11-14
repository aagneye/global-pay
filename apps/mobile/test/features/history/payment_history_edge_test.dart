import 'package:dio/dio.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:globalpay/core/widgets/common.dart';
import 'package:globalpay/data/api/api_client.dart';
import 'package:globalpay/data/api/generated/export.dart' as dto;
import 'package:globalpay/data/repositories/account_repository.dart';
import 'package:globalpay/data/repositories/payments_repository.dart';
import 'package:globalpay/domain/models/money.dart';
import 'package:globalpay/domain/models/payment.dart';
import 'package:globalpay/features/history/history_screen.dart';
import 'package:globalpay/features/pay/confirm_screen.dart';

import '../../support/fake_backend.dart';
import '../../support/near_test_app.dart';
import '../../support/scripted_backend.dart';

const cantReach = "Can't reach GlobalPay. Check your connection and try again.";

/// GET /me/payments answering [payments].
(int, Object?) paymentList(List<Map<String, Object?>> payments) => (200, {'payments': payments});

/// From Home to History, once Home is covered and [until] (its tiles, or its empty or error state) is on screen.
/// [maxFrames] covers Riverpod's retries of a failing history (about 40 s of backoff).
Future<void> openHistory(WidgetTester tester, Finder until, {int maxFrames = 100}) async {
  await tapText(tester, 'History');
  for (var frame = 0; frame < 20 && find.text('Scan & pay').evaluate().isNotEmpty; frame++) {
    await tester.pump(const Duration(milliseconds: 100));
  }
  expect(find.text('Scan & pay'), findsNothing, reason: 'Home is still on screen');
  await pumpUntilFound(tester, until, maxFrames: maxFrames);
}

Finder inTile(String text) => find.descendant(of: find.byType(PaymentTile), matching: find.text(text));

FiatAmount inr(int paise) => FiatAmount(currency: FiatCurrency.inr, minor: BigInt.from(paise));
FiatAmount baht(int satang) => FiatAmount(currency: FiatCurrency.thb, minor: BigInt.from(satang));

void main() {
  group('history', () {
    testWidgets('mixes rupee and baht payments newest first, each with its own symbol, name and status', (
      tester,
    ) async {
      final now = DateTime.now();
      await signedInOnNear(
        tester,
        // Out of order on purpose: the list sorts by date.
        setUp: (backend) => backend.handlers['GET /me/payments'] = (_) => paymentList([
          paymentJson(
            id: 'p_thb_refunded',
            status: 'REFUNDED',
            payoutStatus: 'FAILED',
            refundTx: true,
            createdAt: now.subtract(const Duration(hours: 3)),
          ),
          paymentJson(
            id: 'p_thb_failed',
            status: 'FAILED',
            fiatAmount: '10000000',
            merchantName: null,
            merchantId: '0812345678',
            createdAt: now.subtract(const Duration(days: 1)),
          ),
          paymentJson(
            id: 'p_inr_unknown',
            status: 'PAYOUT_PENDING',
            currency: 'INR',
            fiatAmount: '1',
            tokenAmount: '119',
            merchantName: null,
            merchantId: 'rahul@oksbi',
            payoutStatus: 'UNKNOWN',
            createdAt: now,
          ),
          paymentJson(
            id: 'p_inr_settled',
            status: 'SETTLED',
            currency: 'INR',
            merchantName: 'Chai Point',
            payoutStatus: 'SUCCEEDED',
            payoutReference: FakeBackend.upiReference,
            settleTx: true,
            createdAt: now.subtract(const Duration(hours: 1)),
          ),
        ]),
      );
      await openHistory(tester, find.byType(PaymentTile));

      expect(find.byType(PaymentTile), findsNWidgets(4));
      // Newest first: the unnamed UPI payee shows its UPI ID, the unnamed PromptPay one "PromptPay <id>".
      final titles = ['rahul@oksbi', 'Chai Point', 'GLOBALPAY TEST CAFE', 'PromptPay 0812345678'];
      final tops = [for (final title in titles) tester.getTopLeft(inTile(title)).dy];
      expect(tops, orderedEquals([...tops]..sort()), reason: 'newest first');

      for (final (amount, label) in [
        ('₹0.01', 'Needs review'),
        ('₹250.00', 'Merchant paid'),
        ('฿250.00', 'Refunded'),
        ('฿100000.00', 'Failed'),
      ]) {
        expect(inTile(amount), findsOneWidget, reason: amount);
        expect(inTile(label), findsOneWidget, reason: label);
      }
      expect(find.textContaining('0.000119 USDC'), findsOneWidget);
    });

    testWidgets('no payments yet', (tester) async {
      await signedInOnNear(tester, setUp: (backend) => backend.handlers['GET /me/payments'] = (_) => paymentList([]));
      await openHistory(tester, find.text('No payments yet.'));
      expect(find.byType(PaymentTile), findsNothing);
      expect(find.byType(ErrorView), findsNothing);
    });

    testWidgets("a full page (the API's last 50) scrolls from the newest to the oldest", (tester) async {
      final now = DateTime.now();
      String name(int i) => 'Shop ${i.toString().padLeft(2, '0')}';
      await signedInOnNear(
        tester,
        setUp: (backend) => backend.handlers['GET /me/payments'] = (_) => paymentList([
          for (var i = 1; i <= 50; i++)
            paymentJson(
              id: 'p_$i',
              status: 'SETTLED',
              currency: i.isEven ? 'INR' : 'THB',
              merchantName: name(i),
              createdAt: now.subtract(Duration(minutes: 100 - i)),
            ),
        ]),
      );
      await openHistory(tester, find.byType(PaymentTile));
      expect(inTile(name(50)), findsOneWidget);
      expect(inTile(name(1)), findsNothing);

      await tester.scrollUntilVisible(inTile(name(1)), 400, scrollable: find.byType(Scrollable).last);
      expect(inTile(name(1)), findsOneWidget);
      expect(tester.getTopLeft(inTile(name(2))).dy, lessThan(tester.getTopLeft(inTile(name(1))).dy));
      expect(tester.takeException(), isNull);
    });

    testWidgets('a history that cannot load shows the error, and Try again loads it', (tester) async {
      var online = false;
      await signedInOnNear(
        tester,
        setUp: (backend) => backend.handlers['GET /me/payments'] = (_) =>
            online ? paymentList([paymentJson(status: 'SETTLED', payoutStatus: 'SUCCEEDED', settleTx: true)]) : offline,
      );
      await openHistory(tester, find.text(cantReach), maxFrames: 600);
      expect(find.byType(PaymentTile), findsNothing);

      online = true;
      await tapText(tester, 'Try again');
      await pumpUntilFound(tester, find.byType(PaymentTile));
      expect(find.text(cantReach), findsNothing);
      expect(inTile('GLOBALPAY TEST CAFE'), findsOneWidget);
    });

    testWidgets('reopening a payment from history fetches that payment by its id', (tester) async {
      final now = DateTime.now();
      final settledUpi = paymentJson(
        id: 'p_upi',
        status: 'SETTLED',
        currency: 'INR',
        merchantName: 'Chai Point',
        payoutStatus: 'SUCCEEDED',
        payoutReference: FakeBackend.upiReference,
        settleTx: true,
        createdAt: now,
      );
      final (:backend, wallet: _) = await signedInOnNear(
        tester,
        setUp: (backend) {
          backend.handlers['GET /me/payments'] = (_) => paymentList([
            settledUpi,
            paymentJson(id: 'p_thb', status: 'SETTLED', createdAt: now.subtract(const Duration(hours: 1))),
          ]);
          backend.handlers['GET /payments/p_upi'] = (_) => (200, settledUpi);
        },
      );
      await openHistory(tester, find.byType(PaymentTile));
      await tester.tap(inTile('Chai Point'));
      await pumpUntilFound(tester, find.text('Payment status'));
      await pumpUntilFound(tester, find.text('The merchant received ₹250.00.'));
      expect(find.text('UPI reference'), findsOneWidget);
      expect(find.text(FakeBackend.upiReference), findsOneWidget);
      expect(backend.count('GET', '/payments/p_upi'), 1);
      expect(backend.count('GET', '/payments/p_thb'), 0);

      // A finished payment is fetched once, not polled.
      await tester.pump(const Duration(seconds: 5));
      expect(backend.count('GET', '/payments/p_upi'), 1);
    });

    test(
      "one payment in a currency this build doesn't know doesn't hide the rest of the history",
      () async {
        final backend = ScriptedBackend(FakeBackend(near: true));
        backend.handlers['GET /me/payments'] = (_) => paymentList([
          paymentJson(id: 'p_thb', status: 'SETTLED'),
          paymentJson(id: 'p_vnd', status: 'SETTLED', currency: 'VND', merchantName: 'Pho Hanoi'),
        ]);
        final account = AccountRepository(
          api: ApiClient(nearTestConfig, token: () => 'test-token', dio: Dio()..httpClientAdapter = backend),
        );
        final history = await account.history();
        expect(history.map((payment) => payment.id), contains('p_thb'));
      },
      skip:
          "BUG: paymentFromDto throws an ArgumentError for a fiatCurrency other than THB/INR (FiatCurrency.fromCode), "
          "so one such payment fails GET /me/payments as a whole: History and Home's recent payments show only an "
          "error. Quotes fall back to THB for an unknown currency instead (_quoteFiat).",
    );
  });

  group('money at the boundaries', () {
    test('₹ and ฿ from one paisa/satang to a lakh, and beyond', () {
      expect(inr(1).format(), '₹0.01');
      expect(baht(1).format(), '฿0.01');
      expect(inr(0).format(), '₹0.00');
      expect(inr(10).format(), '₹0.10');
      expect(inr(99).format(), '₹0.99');
      expect(inr(100).format(), '₹1.00');
      expect(inr(10000000).format(), '₹100000.00');
      expect(baht(10000000).format(), '฿100000.00');
      expect(inr(9999999).format(), '₹99999.99');
      expect(
        FiatAmount(currency: FiatCurrency.inr, minor: BigInt.parse('100000000000000000000')).format(),
        '₹1000000000000000000.00',
      );
    });

    test('negative minor units keep their sign', () {
      expect(formatMinorUnits(BigInt.from(-1), 2), '-0.01');
      expect(formatMinorUnits(BigInt.from(-10000000), 2), '-100000.00');
      expect(formatMinorUnits(BigInt.from(-5), 0), '-5');
    });

    test('USDC at the boundaries: exact to the micro-unit, and cut (never rounded up) for display', () {
      expect(usdc('1').format(), '0.000001 USDC');
      expect(usdc('10000').format(), '0.010000 USDC');
      expect(usdc('100000000000').format(), '100000.000000 USDC');
      expect(displayParts(usdc('10000')), (whole: '0', fraction: '.01'));
      expect(displayParts(usdc('9999')), (whole: '0', fraction: '.00'));
      expect(displayParts(usdc('100000000000')), (whole: '100,000', fraction: '.00'));
      expect(displayParts(usdc('999999999999')), (whole: '999,999', fraction: '.99'));
      expect(displayParts(usdc('-1234500000')), (whole: '-1,234', fraction: '.50'));
    });

    test('typed amounts at the boundaries become the right paise/satang', () {
      expect(parseThb('0.01'), BigInt.one);
      expect(parseThb('100000.00'), BigInt.from(10000000));
      expect(parseThb('100000'), BigInt.from(10000000));
      expect(parseThb('0.1'), BigInt.from(10));
      expect(parseThb('00.01'), BigInt.one);
      for (final bad in ['.5', '5.', '1e3', '0.001', ' ', '₹100', '100 000']) {
        expect(parseThb(bad), isNull, reason: bad);
      }
    });

    test('a rate rounds half up to the paisa/satang, even below one', () {
      expect(formatRateE8(BigInt.from(499999), FiatCurrency.inr), '₹0.00');
      expect(formatRateE8(BigInt.from(500000), FiatCurrency.inr), '₹0.01');
      expect(formatRateE8(BigInt.from(10000000000000), FiatCurrency.thb), '฿100000.00');
    });

    test('a payment reads as needing review for an UNKNOWN or REVERSED payout, or one this app does not know', () {
      Payment withPayout(String status) =>
          paymentFromDto(dto.Payment.fromJson(paymentJson(status: 'PAYOUT_PENDING', payoutStatus: status)));
      expect(withPayout('UNKNOWN').statusLabel, 'Needs review');
      expect(withPayout('REVERSED').statusLabel, 'Needs review');
      expect(withPayout('SOMETHING_NEW').statusLabel, 'Needs review');
      expect(withPayout('PENDING').statusLabel, 'Paying merchant');
    });
  });
}
