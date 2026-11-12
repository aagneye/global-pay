import 'package:flutter/material.dart';

/// Shown while the saved session and KYC state load.
class SplashScreen extends StatelessWidget {
  const SplashScreen({super.key});

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Scaffold(
      body: Center(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Text('GlobalPay', style: theme.textTheme.headlineMedium?.copyWith(color: theme.colorScheme.primary)),
            const SizedBox(height: 24),
            const CircularProgressIndicator(),
          ],
        ),
      ),
    );
  }
}
