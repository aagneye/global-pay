import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';
import 'package:globalpay/app/router.dart';
import 'package:globalpay/core/widgets/placeholder_view.dart';

class PaymentStatusScreen extends StatelessWidget {
  const PaymentStatusScreen({super.key, required this.paymentId});

  final String paymentId;

  @override
  Widget build(BuildContext context) {
    return PlaceholderView(
      title: 'Payment status',
      description: 'Payment $paymentId: submitted, paid on Base, baht payout, then settled '
          '(or refunded if the payout fails). Each step links to the block explorer.',
      iteration: 5,
      actions: [PlaceholderAction('Done', () => context.go(Routes.home))],
    );
  }
}
