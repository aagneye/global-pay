import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:globalpay/app/router.dart';
import 'package:globalpay/app/theme.dart';
import 'package:globalpay/core/providers.dart';
import 'package:globalpay/core/widgets/common.dart';
import 'package:globalpay/domain/models/money.dart';
import 'package:globalpay/features/auth/session_controller.dart';
import 'package:globalpay/features/history/history_screen.dart';
import 'package:globalpay/features/home/account_providers.dart';
import 'package:globalpay/features/p2p/p2p_support.dart';

/// Set once the card key step has been offered on this phone.
const cardKeyOnboardingSeenKey = 'card_key_onboarding_seen';

/// Whether to offer the card key step now: on this build, never offered on this phone, and no card key yet.
final cardKeyOnboardingDueProvider = FutureProvider.autoDispose<bool>((ref) async {
  if (!ref.watch(cardKeyOnboardingProvider)) return false;
  if (await ref.watch(secureStoreProvider).read(cardKeyOnboardingSeenKey) != null) return false;
  return await ref.watch(cardKeyStoreProvider).current() == null;
});

class HomeScreen extends ConsumerWidget {
  const HomeScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final theme = Theme.of(context);
    final address = ref.watch(sessionProvider).value?.walletAddress ?? '';
    final balance = ref.watch(balanceProvider);
    // Tap to pay (Request, Pay by tap) and Add money are EVM-only.
    final near = ref.watch(appConfigProvider).isNear;
    final history = ref.watch(historyProvider);
    // Registers this phone for tap to pay (hardware key, push token) once signed in.
    ref.watch(deviceRegistrationProvider);
    // NEAR rail, first sign-in on this phone, no card key yet: offer to make a card the key (once, skippable).
    ref.listen(cardKeyOnboardingDueProvider, (_, next) {
      if (next.value != true) return;
      unawaited(ref.read(secureStoreProvider).write(cardKeyOnboardingSeenKey, '1'));
      context.push(Routes.cardKeySetup);
    });

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
        titleSpacing: 20,
        title: const Wordmark(),
        actions: [
          PopupMenuButton<String>(
            icon: const Icon(Icons.more_horiz),
            tooltip: 'Menu',
            onSelected: (value) {
              if (value == 'sign-out') ref.read(sessionProvider.notifier).signOut();
              if (value == 'name') _editName(context, ref);
              if (value == 'phone') _thisPhone(context, ref);
            },
            itemBuilder: (context) => [
              const PopupMenuItem(value: 'name', child: Text('Your name')),
              if (!near) const PopupMenuItem(value: 'phone', child: Text('This phone')),
              const PopupMenuItem(value: 'sign-out', child: Text('Sign out')),
            ],
          ),
          const SizedBox(width: 8),
        ],
      ),
      body: RefreshIndicator(
        onRefresh: refresh,
        child: ListView(
          padding: const EdgeInsets.fromLTRB(20, 8, 20, 32),
          children: [
            _BalanceCard(balance: balance, address: address, tag: near ? 'USDC · NEAR' : 'USDC'),
            const SizedBox(height: 28),
            Row(
              children: [
                if (!near) ...[
                  _QuickAction(icon: Icons.south_west, label: 'Request', onTap: () => context.push(Routes.request)),
                  _QuickAction(
                    icon: Icons.contactless_outlined,
                    label: 'Pay by tap',
                    onTap: () => context.push(Routes.payByTap),
                  ),
                  _QuickAction(icon: Icons.add, label: 'Add money', onTap: () => context.push(Routes.addMoney)),
                ],
                _QuickAction(icon: Icons.qr_code_2, label: 'Receive', onTap: () => context.push(Routes.receive)),
                if (near) ...[
                  _QuickAction(
                    icon: Icons.contactless_outlined,
                    label: 'Card key',
                    onTap: () => context.push(Routes.cardKey),
                  ),
                  // Keeps the actions the size of one of four.
                  const Spacer(flex: 2),
                ],
              ],
            ),
            const SizedBox(height: 36),
            Row(
              children: [
                Expanded(child: Text('Recent payments', style: theme.textTheme.titleMedium)),
                TextButton(
                  onPressed: () => context.push(Routes.history),
                  child: const Row(
                    mainAxisSize: MainAxisSize.min,
                    children: [Text('History'), SizedBox(width: 4), Icon(Icons.arrow_forward, size: 16)],
                  ),
                ),
              ],
            ),
            const SizedBox(height: 4),
            switch (history) {
              AsyncData(:final value) when value.isEmpty => const _NoPayments(),
              AsyncData(:final value) => Column(children: [for (final p in value.take(3)) PaymentTile(payment: p)]),
              AsyncError(:final error) => ErrorView(error: error, onRetry: () => ref.invalidate(historyProvider)),
              _ => const Padding(
                padding: EdgeInsets.all(24),
                child: Center(child: SizedBox.square(dimension: 20, child: CircularProgressIndicator(strokeWidth: 2))),
              ),
            },
          ],
        ),
      ),
    );
  }
}

/// The black card: balance, address, and the main action.
class _BalanceCard extends StatelessWidget {
  const _BalanceCard({required this.balance, required this.address, required this.tag});

  final AsyncValue<({TokenAmount amount, String token})> balance;
  final String address;

  /// The token (and network) the balance is in, e.g. "USDC".
  final String tag;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    const soft = Color(0x99FFFFFF);
    return Container(
      padding: const EdgeInsets.fromLTRB(24, 22, 24, 24),
      decoration: const BoxDecoration(color: Brand.ink, borderRadius: BorderRadius.all(Radius.circular(28))),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Text('Balance', style: theme.textTheme.labelLarge?.copyWith(color: soft)),
              const Spacer(),
              AccentTag(tag),
            ],
          ),
          const SizedBox(height: 16),
          switch (balance) {
            AsyncData(:final value) => _Amount(value.amount),
            AsyncError(:final error) => Text(
              describeError(error),
              style: theme.textTheme.bodyMedium?.copyWith(color: Brand.paper),
            ),
            _ => const Padding(
              padding: EdgeInsets.symmetric(vertical: 24),
              child: LinearProgressIndicator(color: Brand.paper, backgroundColor: Color(0x33FFFFFF)),
            ),
          },
          const SizedBox(height: 4),
          InkWell(
            onTap: () => copyToClipboard(context, address, label: 'Address copied'),
            borderRadius: const BorderRadius.all(Radius.circular(8)),
            child: Padding(
              padding: const EdgeInsets.symmetric(vertical: 4),
              child: Row(
                mainAxisSize: MainAxisSize.min,
                children: [
                  Text(
                    shortAddress(address),
                    style: theme.textTheme.bodyMedium?.copyWith(color: soft, letterSpacing: 0.4),
                  ),
                  const SizedBox(width: 6),
                  const Icon(Icons.copy_rounded, size: 14, color: soft),
                ],
              ),
            ),
          ),
          const SizedBox(height: 22),
          SizedBox(
            width: double.infinity,
            child: FilledButton.icon(
              onPressed: () => context.push(Routes.scan),
              style: FilledButton.styleFrom(backgroundColor: Brand.paper, foregroundColor: Brand.ink),
              icon: const Icon(Icons.qr_code_scanner),
              label: const Text('Scan & pay'),
            ),
          ),
        ],
      ),
    );
  }
}

/// "10,000" large, ".00" dimmed; screen readers hear the exact amount.
class _Amount extends StatelessWidget {
  const _Amount(this.amount);

  final TokenAmount amount;

  @override
  Widget build(BuildContext context) {
    final parts = displayParts(amount);
    final style = Theme.of(context).textTheme.displaySmall?.copyWith(
      color: Brand.paper,
      fontSize: 46,
      fontWeight: FontWeight.w500,
      letterSpacing: -1.6,
      fontFeatures: const [FontFeature.tabularFigures()],
    );
    return Text.rich(
      key: const Key('balance'),
      semanticsLabel: amount.format(),
      maxLines: 1,
      TextSpan(
        children: [
          TextSpan(text: parts.whole, style: style),
          TextSpan(
            text: parts.fraction,
            style: style?.copyWith(color: const Color(0x80FFFFFF)),
          ),
        ],
      ),
    );
  }
}

/// A round icon with its label underneath.
class _QuickAction extends StatelessWidget {
  const _QuickAction({required this.icon, required this.label, required this.onTap});

  final IconData icon;
  final String label;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    return Expanded(
      child: InkWell(
        onTap: onTap,
        borderRadius: const BorderRadius.all(Radius.circular(16)),
        child: Padding(
          padding: const EdgeInsets.symmetric(vertical: 6),
          child: Column(
            children: [
              Container(
                width: 58,
                height: 58,
                decoration: const BoxDecoration(color: Brand.mist, shape: BoxShape.circle),
                child: Icon(icon, size: 24, color: Brand.ink),
              ),
              const SizedBox(height: 10),
              Text(
                label,
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                style: Theme.of(context).textTheme.labelMedium?.copyWith(fontWeight: FontWeight.w500),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

class _NoPayments extends StatelessWidget {
  const _NoPayments();

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Container(
      width: double.infinity,
      padding: const EdgeInsets.symmetric(vertical: 28, horizontal: 20),
      decoration: BoxDecoration(
        border: Border.all(color: Brand.line),
        borderRadius: const BorderRadius.all(Radius.circular(20)),
      ),
      child: Column(
        children: [
          const Icon(Icons.receipt_long_outlined, color: Brand.muted),
          const SizedBox(height: 10),
          Text('No payments yet.', style: theme.textTheme.titleSmall),
          const SizedBox(height: 4),
          Text(
            'Scan a UPI or PromptPay QR to make your first one.',
            style: theme.textTheme.bodySmall,
            textAlign: TextAlign.center,
          ),
        ],
      ),
    );
  }
}

/// "Your name": what people see when they pay you. It's shown to them as not verified.
Future<void> _editName(BuildContext context, WidgetRef ref) async {
  final name = await showDialog<String>(context: context, builder: (context) => const _NameDialog());
  if (name == null || !context.mounted) return;
  try {
    await ref.read(p2pRepositoryProvider).updateName(name);
    if (context.mounted) ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('Name saved')));
  } on Object catch (error) {
    if (context.mounted) ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(describeError(error))));
  }
}

/// The "Your name" dialog. It owns its text controller, so the controller lives until the dialog has
/// finished closing: disposing it as soon as `showDialog` returns broke the closing animation.
class _NameDialog extends StatefulWidget {
  const _NameDialog();

  @override
  State<_NameDialog> createState() => _NameDialogState();
}

class _NameDialogState extends State<_NameDialog> {
  final _controller = TextEditingController();

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return AlertDialog(
      title: const Text('Your name'),
      content: TextField(
        key: const Key('name-field'),
        controller: _controller,
        autofocus: true,
        decoration: const InputDecoration(helperText: 'People see this when they pay you'),
      ),
      actions: [
        TextButton(onPressed: () => Navigator.pop(context), child: const Text('Cancel')),
        FilledButton(onPressed: () => Navigator.pop(context, _controller.text), child: const Text('Save')),
      ],
    );
  }
}

/// "This phone": turns tap to pay off for this phone, e.g. before giving it away, or back on.
Future<void> _thisPhone(BuildContext context, WidgetRef ref) async {
  final tapToPay = ref.read(tapToPaySwitchProvider);
  final off = await tapToPay.isOff();
  final deviceId = off ? null : await tapToPay.deviceId();
  if (!context.mounted) return;
  final (title, message, action) = switch ((off, deviceId)) {
    (true, _) => (
      'Tap to pay is off',
      "This phone doesn't pay by tap. You can still pay by scanning a code.",
      'Turn on',
    ),
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
      result = await tapToPay.turnOn()
          ? 'Tap to pay is on for this phone'
          : "Couldn't turn tap to pay on. Try again later.";
    } else {
      await tapToPay.turnOff();
      result = 'Tap to pay is off for this phone';
    }
  } on Object catch (error) {
    result = describeError(error);
  }
  if (context.mounted) ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(result)));
}
