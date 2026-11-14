import 'package:flutter/material.dart';
import 'package:globalpay/app/theme.dart';

/// Shown while the saved session and KYC state load.
class SplashScreen extends StatelessWidget {
  const SplashScreen({super.key});

  @override
  Widget build(BuildContext context) {
    return const Scaffold(
      body: Center(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Wordmark(size: 34),
            SizedBox(height: 28),
            SizedBox.square(dimension: 20, child: CircularProgressIndicator(strokeWidth: 2)),
          ],
        ),
      ),
    );
  }
}
