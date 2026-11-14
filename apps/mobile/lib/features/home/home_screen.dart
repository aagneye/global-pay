import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:globalpay/app/router.dart';
import 'package:globalpay/core/widgets/common.dart';
import 'package:globalpay/features/auth/session_controller.dart';
import 'package:globalpay/features/history/history_screen.dart';
import 'package:globalpay/features/home/account_providers.dart';

class HomeScreen extends ConsumerWidget {
  const HomeScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final theme = Theme.of(context);
    final address = ref.watch(sessionProvider).value?.walletAddress ?? '';
    final balance = ref.watch(balanceProvider);
    final history = ref.watch(historyProvider);

    Future<void> refresh() async {
      ref.invalidate(balanceProvider);
      ref.invalidate(historyProvider);
      try {
        await ref.read(balanceProvider.future);
      } on Object {
        // The card shows the error.
      }
    }

    return Scaffold(
      appBar: AppBar(
        title: const Text('GlobalPay'),
        actions: [
          PopupMenuButton<String>(
            onSelected: (value) {
              if (value == 'sign-out') ref.read(sessionProvider.notifier).signOut();
            },
            itemBuilder: (context) => const [PopupMenuItem(value: 'sign-out', child: Text('Sign out'))],
          ),
        ],
      ),
      body: RefreshIndicator(
        onRefresh: refresh,
        child: ListView(
          padding: const EdgeInsets.all(16),
          children: [
            Card(
              child: Padding(
                padding: const EdgeInsets.all(20),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text('USDC balance', style: theme.textTheme.labelLarge),
                    const SizedBox(height: 8),
                    switch (balance) {
                      AsyncData(:final value) => Text(
                        value.amount.format(),
                        key: const Key('balance'),
                        style: theme.textTheme.headlineMedium,
                      ),
                      AsyncError(:final error) => Text(describeError(error), style: theme.textTheme.bodyMedium),
                      _ => const LinearProgressIndicator(),
                    },
                    const SizedBox(height: 12),
                    InkWell(
                      onTap: () => copyToClipboard(context, address, label: 'Address copied'),
                      child: Row(
                        children: [
                          Text(shortAddress(address), style: theme.textTheme.bodyMedium),
                          const SizedBox(width: 6),
                          Icon(Icons.copy, size: 16, color: theme.colorScheme.outline),
                        ],
                      ),
                    ),
                  ],
                ),
              ),
            ),
            const SizedBox(height: 16),
            FilledButton.icon(
              onPressed: () => context.push(Routes.scan),
              icon: const Icon(Icons.qr_code_scanner),
              label: const Text('Scan & pay'),
              style: FilledButton.styleFrom(minimumSize: const Size.fromHeight(56)),
            ),
            const SizedBox(height: 12),
            FilledButton.tonalIcon(
              onPressed: () => context.push(Routes.addMoney),
              icon: const Icon(Icons.add_card),
              label: const Text('Add money'),
              style: FilledButton.styleFrom(minimumSize: const Size.fromHeight(48)),
            ),
            const SizedBox(height: 12),
            Row(
              children: [
                Expanded(
                  child: OutlinedButton.icon(
                    onPressed: () => context.push(Routes.receive),
                    icon: const Icon(Icons.qr_code),
                    label: const Text('Receive'),
                  ),
                ),
                const SizedBox(width: 12),
                Expanded(
                  child: OutlinedButton.icon(
                    onPressed: () => context.push(Routes.history),
                    icon: const Icon(Icons.receipt_long),
                    label: const Text('History'),
                  ),
                ),
              ],
            ),
            const SizedBox(height: 24),
            Text('Recent payments', style: theme.textTheme.titleMedium),
            const SizedBox(height: 8),
            switch (history) {
              AsyncData(:final value) when value.isEmpty => Padding(
                padding: const EdgeInsets.symmetric(vertical: 16),
                child: Text('No payments yet.', style: theme.textTheme.bodyMedium),
              ),
              AsyncData(:final value) => Column(children: [for (final p in value.take(3)) PaymentTile(payment: p)]),
              AsyncError(:final error) => ErrorView(error: error, onRetry: () => ref.invalidate(historyProvider)),
              _ => const Padding(
                padding: EdgeInsets.all(16),
                child: Center(child: CircularProgressIndicator()),
              ),
            },
          ],
        ),
      ),
    );
  }
}
