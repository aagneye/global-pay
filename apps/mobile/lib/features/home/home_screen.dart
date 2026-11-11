import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';
import 'package:globalpay/app/router.dart';
import 'package:globalpay/core/widgets/placeholder_view.dart';

class HomeScreen extends StatelessWidget {
  const HomeScreen({super.key});

  @override
  Widget build(BuildContext context) {
    return PlaceholderView(
      title: 'GlobalPay',
      description: 'Your USDC balance and its value in baht, plus your recent payments.',
      iteration: 5,
      actions: [
        PlaceholderAction('Scan & pay', () => context.push(Routes.scan)),
        PlaceholderAction('Receive', () => context.push(Routes.receive)),
        PlaceholderAction('History', () => context.push(Routes.history)),
      ],
    );
  }
}
