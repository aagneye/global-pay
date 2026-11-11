import 'package:flutter/material.dart';
import 'package:globalpay/core/widgets/placeholder_view.dart';

class ReceiveScreen extends StatelessWidget {
  const ReceiveScreen({super.key});

  @override
  Widget build(BuildContext context) {
    return const PlaceholderView(
      title: 'Receive USDC',
      description: 'Your Base address as a QR code, plus a payment-request link '
          '(EIP-681) to send to clients.',
      iteration: 5,
    );
  }
}
