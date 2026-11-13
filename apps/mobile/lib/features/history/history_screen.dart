import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:globalpay/app/router.dart';
import 'package:globalpay/core/widgets/common.dart';
import 'package:globalpay/domain/models/payment.dart';
import 'package:globalpay/features/home/account_providers.dart';

class HistoryScreen extends ConsumerWidget {
  const HistoryScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final history = ref.watch(historyProvider);
    return Scaffold(
      appBar: AppBar(title: const Text('History')),
      body: RefreshIndicator(
        onRefresh: () => ref.refresh(historyProvider.future),
        child: switch (history) {
          AsyncData(:final value) when value.isEmpty => ListView(
            children: const [
              Padding(
                padding: EdgeInsets.all(32),
                child: Center(child: Text('No payments yet.')),
              ),
            ],
          ),
          AsyncData(:final value) => ListView(
            padding: const EdgeInsets.all(8),
            children: [for (final payment in value) PaymentTile(payment: payment)],
          ),
          AsyncError(:final error) => ListView(
            children: [ErrorView(error: error, onRetry: () => ref.invalidate(historyProvider))],
          ),
          _ => const Center(child: CircularProgressIndicator()),
        },
      ),
    );
  }
}

/// One payment in a list: merchant, baht amount, USDC paid, status. Opens its status screen.
class PaymentTile extends StatelessWidget {
  const PaymentTile({super.key, required this.payment});

  final Payment payment;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final color = switch (payment.status) {
      _ when payment.needsReview => theme.colorScheme.error,
      PaymentStatus.settled => theme.colorScheme.primary,
      PaymentStatus.failed || PaymentStatus.refunded => theme.colorScheme.error,
      _ => theme.colorScheme.tertiary,
    };
    final date = MaterialLocalizations.of(context).formatShortDate(payment.createdAt.toLocal());
    return ListTile(
      onTap: () => context.push(Routes.status(payment.id)),
      leading: CircleAvatar(child: Text(payment.merchantName.isEmpty ? '?' : payment.merchantName[0])),
      title: Text(payment.merchantName, maxLines: 1, overflow: TextOverflow.ellipsis),
      subtitle: Text('$date · ${payment.tokenAmount.format()}'),
      trailing: Column(
        mainAxisAlignment: MainAxisAlignment.center,
        crossAxisAlignment: CrossAxisAlignment.end,
        children: [
          Text(payment.fiatAmount.format(), style: theme.textTheme.titleSmall),
          Text(payment.statusLabel, style: theme.textTheme.labelSmall?.copyWith(color: color)),
        ],
      ),
    );
  }
}
