import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:globalpay/features/pay/payment_status_screen.dart';

import '../../support/fake_backend.dart';
import '../../support/near_test_app.dart';
import '../../support/scripted_backend.dart';

const cantReach = "Can't reach GlobalPay. Check your connection and try again.";

/// Rewrites the signed quote inside a nearPayment's msg (the quote JSON is a string inside the msg JSON).
void rewriteSignedQuote(Map<String, dynamic> nearPayment, void Function(Map<String, dynamic> quote) change) {
  final args = nearPayment['args'] as Map<String, dynamic>;
  final msg = jsonDecode(args['msg'] as String) as Map<String, dynamic>;
  final quote = jsonDecode(msg['quote'] as String) as Map<String, dynamic>;
  change(quote);
  args['msg'] = jsonEncode({...msg, 'quote': jsonEncode(quote)});
}

/// The payment-status steps that are ticked.
Finder tickedSteps() => find.descendant(of: find.byType(ListTile), matching: find.byIcon(Icons.check_circle));

String headline(WidgetTester tester) => tester.widget<Text>(find.byKey(const Key('status-headline'))).data!;

void main() {
  group('quote expiry', () {
    testWidgets('a quote that runs out before Pay offers a new quote; nothing is signed or posted', (tester) async {
      final (:backend, :wallet) = await signedInOnNear(
        tester,
        setUp: (backend) {
          var quotes = 0;
          // Only the first quote is short: the next one lasts the usual minute.
          backend.rewrites['POST /quotes'] = (json) {
            if (quotes++ == 0) {
              json['expiresAt'] = DateTime.now().add(const Duration(seconds: 2)).toUtc().toIso8601String();
            }
          };
        },
      );
      await quotePromptPay250(tester);
      expect(find.text('Expired'), findsNothing);

      // Real time passes (the screen reads the wall clock), then its one-second ticker redraws.
      await tester.runAsync(() => Future<void>.delayed(const Duration(milliseconds: 2300)));
      await tester.pump(const Duration(seconds: 1));
      expect(find.text('Expired'), findsOneWidget);
      expect(find.text('Get a new quote'), findsOneWidget);
      expect(find.text(payPromptPay250), findsNothing);
      expect(wallet.signedPayments, isEmpty);
      expect(backend.count('POST', '/payments'), 0);

      await tapText(tester, 'Get a new quote');
      await pumpUntilFound(tester, find.text(payPromptPay250));
      expect(backend.count('POST', '/quotes'), 2);
      await tapText(tester, payPromptPay250);
      await pumpUntilFound(tester, find.text('Payment status'));
      expect(backend.count('POST', '/payments'), 1);
      expect(wallet.signedPayments, hasLength(1));
    });

    testWidgets('Pay tapped just after the quote ran out (before the screen redrew) is refused before signing', (
      tester,
    ) async {
      final (:backend, :wallet) = await signedInOnNear(
        tester,
        setUp: (backend) {
          backend.rewrites['POST /quotes'] = (json) {
            final expiresAt = DateTime.now().add(const Duration(milliseconds: 1500));
            json['expiresAt'] = expiresAt.toUtc().toIso8601String();
            rewriteSignedQuote(
              json['nearPayment'] as Map<String, dynamic>,
              (quote) => quote['expires_at_ms'] = expiresAt.millisecondsSinceEpoch,
            );
          };
        },
      );
      await quotePromptPay250(tester);

      // The quote runs out in real time, but no frame is drawn, so Pay is still on screen.
      await tester.runAsync(() => Future<void>.delayed(const Duration(milliseconds: 1800)));
      await tester.tap(find.text(payPromptPay250));
      await tester.pump();

      await pumpUntilFound(tester, find.textContaining('Stopped before signing'));
      expect(find.textContaining('(the time limit)'), findsOneWidget);
      expect(wallet.signedPayments, isEmpty);
      expect(backend.count('POST', '/payments'), 0);
      expect(find.text('Get a new quote'), findsOneWidget);
    });
  });

  group('refuses to sign a tampered nearPayment (more variants): nothing is signed or posted', () {
    Future<void> payTampered(WidgetTester tester, void Function(Map<String, dynamic> json) tamper, String what) async {
      final (:backend, :wallet) = await signedInOnNear(
        tester,
        setUp: (backend) => backend.rewrites['POST /quotes'] = tamper,
      );
      await quotePromptPay250(tester);
      await tapText(tester, payPromptPay250);

      await pumpUntilFound(tester, find.textContaining('Stopped before signing'));
      expect(find.textContaining('($what)'), findsOneWidget);
      expect(find.textContaining('Nothing was signed'), findsOneWidget);
      expect(wallet.signedPayments, isEmpty);
      expect(backend.count('POST', '/payments'), 0);
      expect(find.text('Payment status'), findsNothing);
    }

    void Function(Map<String, dynamic>) nearPayment(void Function(Map<String, dynamic> payment) change) =>
        (json) => change(json['nearPayment'] as Map<String, dynamic>);

    final variants = <(String, void Function(Map<String, dynamic>), String)>[
      ('no nearPayment at all (an EVM-style quote)', (json) => json.remove('nearPayment'), 'the kind of payment'),
      ('a plain ft_transfer', nearPayment((p) => p['methodName'] = 'ft_transfer'), 'the kind of payment'),
      ('signed by another account', nearPayment((p) => p['signerId'] = 'attacker.testnet'), 'your wallet'),
      (
        'attaching a whole NEAR instead of 1 yoctoNEAR',
        nearPayment((p) => p['deposit'] = '1000000000000000000000000'),
        'the deposit',
      ),
      ('asking for more gas than one call allows', nearPayment((p) => p['gas'] = '300000000000001'), 'the gas'),
      ('a nonce past u64', nearPayment((p) => p['nonce'] = '18446744073709551616'), 'the time limit'),
      (
        'a msg that is not the signed quote',
        nearPayment((p) => (p['args'] as Map)['msg'] = 'pay attacker.testnet'),
        'the quote',
      ),
      (
        'a quote signed for another payer',
        nearPayment((p) => rewriteSignedQuote(p, (q) => q['payer'] = 'attacker.testnet')),
        'your wallet',
      ),
      (
        'a quote that has already expired',
        nearPayment(
          (p) => rewriteSignedQuote(p, (q) => q['expires_at_ms'] = DateTime.now().millisecondsSinceEpoch - 1000),
        ),
        'the time limit',
      ),
      (
        'a quote for less than the transfer',
        nearPayment((p) => rewriteSignedQuote(p, (q) => q['token_amount'] = '1')),
        'the amount',
      ),
    ];
    for (final (name, tamper, what) in variants) {
      testWidgets(name, (tester) => payTampered(tester, tamper, what));
    }
  });

  group('POST /payments failures', () {
    testWidgets('a dropped connection keeps the quote; paying again posts the same signed delegate, once', (
      tester,
    ) async {
      final (:backend, :wallet) = await signedInOnNear(
        tester,
        setUp: (backend) {
          var posts = 0;
          backend.handlers['POST /payments'] = (_) => posts++ == 0 ? offline : null;
        },
      );
      await quotePromptPay250(tester);
      await tapText(tester, payPromptPay250);

      await pumpUntilFound(tester, find.text(cantReach));
      expect(find.text('Payment status'), findsNothing);
      expect(find.text(payPromptPay250), findsOneWidget);
      expect(wallet.signedPayments, hasLength(1));

      await tapText(tester, payPromptPay250);
      await pumpUntilFound(tester, find.text('Payment status'));
      final posted = backend.bodies('POST', '/payments').toList();
      expect(posted, hasLength(2));
      // The same quote and the same signed meta transaction (same nonce): NEAR runs it at most once.
      expect(posted[1], posted[0]);
      expect((posted[0]! as Map)['quoteId'], FakeBackend.quoteId);
      expect(backend.count('POST', '/quotes'), 1);
      await pumpUntilFound(tester, find.text('The merchant received ฿250.00.'), maxFrames: 50);
    });

    testWidgets('a payment the backend refuses shows why and opens no status screen', (tester) async {
      final (:backend, :wallet) = await signedInOnNear(
        tester,
        setUp: (backend) =>
            backend.handlers['POST /payments'] = (_) =>
                (409, {'error': 'quote_expired', 'message': 'This quote has expired. Get a new quote.'}),
      );
      await quotePromptPay250(tester);
      await tapText(tester, payPromptPay250);

      await pumpUntilFound(tester, find.text('This quote has expired. Get a new quote.'));
      expect(find.text('Payment status'), findsNothing);
      expect(backend.count('POST', '/payments'), 1);
      expect(backend.count('GET', '/payments/${FakeBackend.paymentId}'), 0);
      expect(wallet.signedPayments, hasLength(1));
    });

    testWidgets('a server error on POST /payments shows its message, and Pay stays available', (tester) async {
      final (:backend, wallet: _) = await signedInOnNear(
        tester,
        setUp: (backend) =>
            backend.handlers['POST /payments'] = (_) =>
                (500, {'error': 'internal_error', 'message': 'Something went wrong on our side'}),
      );
      await quotePromptPay250(tester);
      await tapText(tester, payPromptPay250);

      await pumpUntilFound(tester, find.text('Something went wrong on our side'));
      expect(find.text(payPromptPay250), findsOneWidget);
      expect(find.text('Payment status'), findsNothing);
      expect(backend.count('POST', '/payments'), 1);
    });
  });

  group('payment status polling', () {
    const route = 'GET /payments/${FakeBackend.paymentId}';

    testWidgets('SUBMITTED -> PAID -> PAYOUT_PENDING -> SETTLED, one step at a time, then polling stops', (
      tester,
    ) async {
      final (:backend, wallet: _) = await signedInOnNear(
        tester,
        setUp: (backend) => backend.sequence(route, [
          (200, paymentJson(status: 'SUBMITTED')),
          (200, paymentJson(status: 'PAID')),
          (200, paymentJson(status: 'PAYOUT_PENDING', payoutStatus: 'PENDING')),
          (
            200,
            paymentJson(
              status: 'SETTLED',
              payoutStatus: 'SUCCEEDED',
              payoutReference: FakeBackend.bankReference,
              settleTx: true,
            ),
          ),
        ]),
      );
      await openStatus(tester);

      await pumpUntilFound(tester, find.byKey(const Key('status-headline')));
      expect(headline(tester), 'Processing');
      expect(tickedSteps(), findsNWidgets(1));
      expect(find.text('Done'), findsNothing);

      await tester.pump(statusPollInterval);
      await tester.pump();
      expect(headline(tester), 'Processing');
      expect(tickedSteps(), findsNWidgets(2));

      await tester.pump(statusPollInterval);
      await tester.pump();
      expect(tickedSteps(), findsNWidgets(3));
      expect(find.text('Paying the merchant in baht'), findsOneWidget);
      expect(find.text('Bank reference'), findsNothing);

      await tester.pump(statusPollInterval);
      await tester.pump();
      expect(headline(tester), 'Merchant paid');
      expect(tickedSteps(), findsNWidgets(4));
      expect(find.text('The merchant received ฿250.00.'), findsOneWidget);
      expect(find.text(FakeBackend.bankReference), findsOneWidget);
      expect(find.text('Settlement transaction'), findsOneWidget);
      expect(find.text('Done'), findsOneWidget);
      expect(backend.count('GET', '/payments/${FakeBackend.paymentId}'), 4);

      await tester.pump(const Duration(seconds: 10));
      expect(backend.count('GET', '/payments/${FakeBackend.paymentId}'), 4);
    });

    testWidgets('FAILED shows the reason and that no money moved, without progress steps', (tester) async {
      final (:backend, wallet: _) = await signedInOnNear(
        tester,
        setUp: (backend) => backend.sequence(route, [
          (200, paymentJson(status: 'SUBMITTED')),
          (200, paymentJson(status: 'FAILED', failureReason: 'The relayer could not submit the transaction')),
        ]),
      );
      await openStatus(tester);
      await pumpUntilFound(tester, find.text('Payment failed'));
      expect(find.text('No money moved.'), findsOneWidget);
      expect(find.text('Reason'), findsOneWidget);
      expect(find.text('The relayer could not submit the transaction'), findsOneWidget);
      expect(find.text('Payment sent'), findsNothing);
      expect(find.text('Merchant paid'), findsNothing);
      expect(find.text('Done'), findsOneWidget);

      await tester.pump(const Duration(seconds: 5));
      expect(backend.count('GET', '/payments/${FakeBackend.paymentId}'), 2);
    });

    testWidgets('REFUNDED in rupees shows the refund transaction and no UPI reference', (tester) async {
      await signedInOnNear(
        tester,
        setUp: (backend) => backend.sequence(route, [
          (
            200,
            paymentJson(status: 'PAYOUT_PENDING', currency: 'INR', merchantName: 'Chai Point', payoutStatus: 'PENDING'),
          ),
          (
            200,
            paymentJson(
              status: 'REFUNDED',
              currency: 'INR',
              merchantName: 'Chai Point',
              payoutStatus: 'FAILED',
              failureReason: 'UPI payout declined by the bank',
              refundTx: true,
            ),
          ),
        ]),
      );
      await openStatus(tester);
      await pumpUntilFound(tester, find.text('Paying the merchant in rupees'));
      await pumpUntilFound(tester, find.text('Refunded'));
      expect(find.text('The merchant payout failed, so your USDC was returned.'), findsOneWidget);
      expect(find.text('UPI payout declined by the bank'), findsOneWidget);
      expect(find.text('USDC refunded'), findsOneWidget);
      expect(find.text('Refund transaction'), findsOneWidget);
      expect(find.text('Settlement transaction'), findsNothing);
      expect(find.text('UPI reference'), findsNothing);
      expect(find.text('₹250.00'), findsOneWidget);
    });

    testWidgets('payout UNKNOWN is shown as being checked, re-checked every 10 s (not every second) until settled', (
      tester,
    ) async {
      final (:backend, wallet: _) = await signedInOnNear(
        tester,
        setUp: (backend) => backend.sequence(route, [
          (200, paymentJson(status: 'PAYOUT_PENDING', payoutStatus: 'UNKNOWN')),
          (200, paymentJson(status: 'PAYOUT_PENDING', payoutStatus: 'UNKNOWN')),
          (
            200,
            paymentJson(
              status: 'SETTLED',
              payoutStatus: 'SUCCEEDED',
              payoutReference: FakeBackend.bankReference,
              settleTx: true,
            ),
          ),
        ]),
      );
      int polls() => backend.count('GET', '/payments/${FakeBackend.paymentId}');
      await openStatus(tester);
      await pumpUntilFound(tester, find.text('Needs review'));
      expect(find.textContaining("We're confirming with our payout partner"), findsOneWidget);
      expect(find.text('The merchant received ฿250.00.'), findsNothing);
      expect(find.text('Done'), findsNothing);
      final first = polls();

      await tester.pump(const Duration(seconds: 5));
      expect(polls(), first);
      await tester.pump(const Duration(seconds: 5));
      await tester.pump();
      expect(polls(), first + 1);
      expect(headline(tester), 'Needs review');

      await tester.pump(reviewPollInterval);
      await tester.pump();
      expect(headline(tester), 'Merchant paid');
      expect(find.text('Done'), findsOneWidget);
    });

    testWidgets('a payout status this app does not know is treated as being checked, never as paid', (tester) async {
      await signedInOnNear(
        tester,
        setUp: (backend) =>
            backend.sequence(route, [(200, paymentJson(status: 'PAYOUT_PENDING', payoutStatus: 'MANUAL_REVIEW'))]),
      );
      await openStatus(tester);
      await pumpUntilFound(tester, find.byKey(const Key('status-headline')));
      expect(headline(tester), 'Needs review');
      expect(find.text('The merchant received ฿250.00.'), findsNothing);
    });

    testWidgets("a REVERSED payout says the merchant's bank returned it", (tester) async {
      await signedInOnNear(
        tester,
        setUp: (backend) =>
            backend.sequence(route, [(200, paymentJson(status: 'SETTLED', payoutStatus: 'REVERSED', settleTx: true))]),
      );
      await openStatus(tester);
      await pumpUntilFound(tester, find.byKey(const Key('status-headline')));
      expect(headline(tester), 'Needs review');
      expect(find.textContaining("The merchant's bank returned the payment"), findsOneWidget);
      expect(find.text('The merchant received ฿250.00.'), findsNothing);
    });

    testWidgets('a first load that fails shows the error, then keeps polling until the payment shows', (tester) async {
      await signedInOnNear(
        tester,
        setUp: (backend) => backend.sequence(route, [
          offline,
          (503, {'error': 'service_unavailable', 'message': 'Temporarily unavailable'}),
          (200, paymentJson(status: 'PAID')),
          (200, paymentJson(status: 'SETTLED', payoutStatus: 'SUCCEEDED', settleTx: true)),
        ]),
      );
      await openStatus(tester);
      await pumpUntilFound(tester, find.text(cantReach));
      expect(find.byKey(const Key('status-headline')), findsNothing);
      await pumpUntilFound(tester, find.text('Temporarily unavailable'));
      await pumpUntilFound(tester, find.text('Processing'));
      await pumpUntilFound(tester, find.text('The merchant received ฿250.00.'));
      expect(find.text(cantReach), findsNothing);
      expect(tester.takeException(), isNull);
    });

    testWidgets('a dropped connection mid-way says Reconnecting, keeps the last status, then recovers', (tester) async {
      await signedInOnNear(
        tester,
        setUp: (backend) => backend.sequence(route, [
          (200, paymentJson(status: 'PAID')),
          offline,
          (200, paymentJson(status: 'SETTLED', payoutStatus: 'SUCCEEDED', settleTx: true)),
        ]),
      );
      await openStatus(tester);
      await pumpUntilFound(tester, find.text('Processing'));
      await pumpUntilFound(tester, find.textContaining('Reconnecting…'));
      expect(find.textContaining(cantReach), findsOneWidget);
      expect(headline(tester), 'Processing');
      expect(tickedSteps(), findsNWidgets(2));

      await pumpUntilFound(tester, find.text('The merchant received ฿250.00.'));
      expect(find.textContaining('Reconnecting…'), findsNothing);
      expect(tester.takeException(), isNull);
    });

    testWidgets('leaving the status screen stops polling', (tester) async {
      final (:backend, wallet: _) = await signedInOnNear(
        tester,
        setUp: (backend) => backend.sequence(route, [(200, paymentJson(status: 'PAID'))]),
      );
      int polls() => backend.count('GET', '/payments/${FakeBackend.paymentId}');
      await openStatus(tester);
      await pumpUntilFound(tester, find.text('Processing'));
      await tester.pump(const Duration(seconds: 3));
      expect(polls(), greaterThan(1));

      await tester.pageBack();
      // Frame by frame until the route is gone (one long pump would run every timer before the pop finishes).
      final screen = find.byType(PaymentStatusScreen, skipOffstage: false);
      for (var frame = 0; frame < 20 && screen.evaluate().isNotEmpty; frame++) {
        await tester.pump(const Duration(milliseconds: 100));
      }
      expect(screen, findsNothing);
      final left = polls();
      for (var second = 0; second < 10; second++) {
        await tester.pump(const Duration(seconds: 1));
      }
      expect(polls(), left);
      expect(tester.takeException(), isNull);
    });
  });
}
