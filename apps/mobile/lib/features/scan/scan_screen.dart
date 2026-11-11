import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';
import 'package:globalpay/app/router.dart';
import 'package:globalpay/core/widgets/placeholder_view.dart';

class ScanScreen extends StatelessWidget {
  const ScanScreen({super.key});

  @override
  Widget build(BuildContext context) {
    return PlaceholderView(
      title: 'Scan to pay',
      description: 'Point the camera at any PromptPay QR. The app checks it instantly; '
          'the backend checks it again before quoting.',
      iteration: 5,
      actions: [PlaceholderAction('Use a test QR', () => context.push(Routes.confirm))],
    );
  }
}
