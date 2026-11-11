import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';
import 'package:globalpay/app/router.dart';
import 'package:globalpay/core/widgets/placeholder_view.dart';

class LoginScreen extends StatelessWidget {
  const LoginScreen({super.key});

  @override
  Widget build(BuildContext context) {
    return PlaceholderView(
      title: 'Sign in',
      description: 'Sign in with email or Google. GlobalPay creates a wallet that only you '
          'control, then signs you in to the backend with Sign-In with Ethereum.',
      iteration: 5,
      actions: [PlaceholderAction('Continue with dev wallet', () => context.go(Routes.kyc))],
    );
  }
}
