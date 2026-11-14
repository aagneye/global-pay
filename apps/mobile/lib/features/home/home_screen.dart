import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:globalpay/app/router.dart';
import 'package:globalpay/core/providers.dart';
import 'package:globalpay/core/widgets/common.dart';
import 'package:globalpay/features/auth/session_controller.dart';
import 'package:globalpay/features/history/history_screen.dart';
import 'package:globalpay/features/home/account_providers.dart';
import 'package:globalpay/features/p2p/p2p_support.dart';

class HomeScreen extends ConsumerWidget {
  const HomeScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final theme = Theme.of(context);
    final address = ref.watch(sessionProvider).value?.walletAddress ?? '';
    final balance = ref.watch(balanceProvider);
    final history = ref.watch(historyProvider);
    // Registers this phone for tap to pay (hardware key, push token) once signed in.
    ref.watch(deviceRegistrationProvider);

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
              if (value == 'name') _editName(context, ref);
              if (value == 'phone') _thisPhone(context, ref);
            },
            itemBuilder: (context) => const [
              PopupMenuItem(value: 'name', child: Text('Your name')),
              PopupMenuItem(value: 'phone', child: Text('This phone')),
              PopupMenuItem(value: 'sign-out', child: Text('Sign out')),
            ],
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
            Row(
              children: [
                Expanded(
                  child: FilledButton.tonalIcon(
                    onPressed: () => context.push(Routes.request),
                    icon: const Icon(Icons.call_received),
                    label: const Text('Request'),
                  ),
                ),
                const SizedBox(width: 12),
                Expanded(
                  child: FilledButton.tonalIcon(
                    onPressed: () => context.push(Routes.payByTap),
                    icon: const Icon(Icons.contactless),
                    label: const Text('Pay by tap'),
                  ),
                ),
              ],
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

/// "Your name": what people see when they pay you. It's shown to them as not verified.
Future<void> _editName(BuildContext context, WidgetRef ref) async {
  final controller = TextEditingController();
  final name = await showDialog<String>(
    context: context,
    builder: (context) => AlertDialog(
      title: const Text('Your name'),
      content: TextField(
        key: const Key('name-field'),
        controller: controller,
        autofocus: true,
        decoration: const InputDecoration(helperText: 'People see this when they pay you'),
      ),
      actions: [
        TextButton(onPressed: () => Navigator.pop(context), child: const Text('Cancel')),
        FilledButton(onPressed: () => Navigator.pop(context, controller.text), child: const Text('Save')),
      ],
    ),
  );
  controller.dispose();
  if (name == null || !context.mounted) return;
  try {
    await ref.read(p2pRepositoryProvider).updateName(name);
    if (context.mounted) ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('Name saved')));
  } on Object catch (error) {
    if (context.mounted) ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(describeError(error))));
  }
}

/// "This phone": turns tap to pay off for this phone, e.g. before giving it away, or back on.
Future<void> _thisPhone(BuildContext context, WidgetRef ref) async {
  final tapToPay = ref.read(tapToPaySwitchProvider);
  final off = await tapToPay.isOff();
  final deviceId = off ? null : await tapToPay.deviceId();
  if (!context.mounted) return;
  final (title, message, action) = switch ((off, deviceId)) {
    (true, _) => ('Tap to pay is off', "This phone doesn't pay by tap. You can still pay by scanning a code.", 'Turn on'),
    (false, null) => ('This phone', "This phone can't pay by tap. You can still pay by scanning a code.", null),
    (false, _) => (
      'Turn off tap to pay?',
      'This phone will stop paying by tap, for example if you are giving it away. '
          'You can still pay by scanning a code, and turn it back on here.',
      'Turn off',
    ),
  };
  final confirmed = await showDialog<bool>(
    context: context,
    builder: (context) => AlertDialog(
      title: Text(title),
      content: Text(message),
      actions: [
        TextButton(onPressed: () => Navigator.pop(context, false), child: Text(action == null ? 'OK' : 'Cancel')),
        if (action != null) FilledButton(onPressed: () => Navigator.pop(context, true), child: Text(action)),
      ],
    ),
  );
  if (confirmed != true || !context.mounted) return;
  String result;
  try {
    if (off) {
      result = await tapToPay.turnOn() ? 'Tap to pay is on for this phone' : "Couldn't turn tap to pay on. Try again later.";
    } else {
      await tapToPay.turnOff();
      result = 'Tap to pay is off for this phone';
    }
  } on Object catch (error) {
    result = describeError(error);
  }
  if (context.mounted) ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(result)));
}
