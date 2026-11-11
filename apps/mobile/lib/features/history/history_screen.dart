import 'package:flutter/material.dart';
import 'package:globalpay/core/widgets/placeholder_view.dart';

class HistoryScreen extends StatelessWidget {
  const HistoryScreen({super.key});

  @override
  Widget build(BuildContext context) {
    return const PlaceholderView(
      title: 'History',
      description: 'Every payment with its status, amounts and block-explorer links.',
      iteration: 5,
    );
  }
}
