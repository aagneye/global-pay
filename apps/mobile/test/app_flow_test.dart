import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:globalpay/app/app.dart';

Future<void> tapAndSettle(WidgetTester tester, String label) async {
  await tester.tap(find.text(label));
  await tester.pumpAndSettle();
}

void main() {
  testWidgets('walks the payment flow through the skeleton screens', (tester) async {
    await tester.pumpWidget(const ProviderScope(child: GlobalPayApp()));
    await tester.pumpAndSettle();
    expect(find.text('Sign in'), findsOneWidget);

    await tapAndSettle(tester, 'Continue with dev wallet');
    expect(find.text('Verify your identity'), findsOneWidget);

    await tapAndSettle(tester, 'Continue');
    expect(find.widgetWithText(AppBar, 'GlobalPay'), findsOneWidget);

    await tapAndSettle(tester, 'Scan & pay');
    expect(find.text('Scan to pay'), findsOneWidget);

    await tapAndSettle(tester, 'Use a test QR');
    expect(find.text('Confirm payment'), findsOneWidget);

    await tapAndSettle(tester, 'Confirm and sign');
    expect(find.text('Payment status'), findsOneWidget);

    await tapAndSettle(tester, 'Done');
    expect(find.widgetWithText(AppBar, 'GlobalPay'), findsOneWidget);
  });
}
