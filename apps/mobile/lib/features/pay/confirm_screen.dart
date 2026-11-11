import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';
import 'package:globalpay/app/router.dart';
import 'package:globalpay/core/widgets/placeholder_view.dart';

class ConfirmScreen extends StatelessWidget {
  const ConfirmScreen({super.key});

  @override
  Widget build(BuildContext context) {
    return PlaceholderView(
      title: 'Confirm payment',
      description: 'Merchant, amount in baht, the USDC you pay, the rate and the fee. '
          'The quote is locked for 60 seconds; confirming asks your wallet to sign it.',
      iteration: 5,
      actions: [
        PlaceholderAction('Confirm and sign', () => context.go(Routes.status('demo'))),
      ],
    );
  }
}
