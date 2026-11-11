import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';
import 'package:globalpay/app/router.dart';
import 'package:globalpay/core/widgets/placeholder_view.dart';

class KycScreen extends StatelessWidget {
  const KycScreen({super.key});

  @override
  Widget build(BuildContext context) {
    return PlaceholderView(
      title: 'Verify your identity',
      description: 'Passport and visa check through the KYC partner (simulated in the demo). '
          'Your tier sets your payment limits.',
      iteration: 5,
      actions: [PlaceholderAction('Continue', () => context.go(Routes.home))],
    );
  }
}
