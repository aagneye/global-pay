import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:globalpay/app/router.dart';
import 'package:globalpay/app/theme.dart';
import 'package:globalpay/core/providers.dart';
import 'package:globalpay/core/widgets/common.dart';
import 'package:globalpay/features/card_key/card_widgets.dart';

/// Shown once a card is registered.
const cardRegisteredMessage = 'Card registered · approve payments with card + fingerprint';

/// Card key: the contactless bank card you already have becomes the key that approves payments. Register it by
/// tapping it on the back of the phone; remove it any time.
///
/// [onboarding]: the step right after a first sign-in, which can be skipped and continues to Home.
class CardKeyScreen extends ConsumerStatefulWidget {
  const CardKeyScreen({super.key, this.onboarding = false});

  final bool onboarding;

  @override
  ConsumerState<CardKeyScreen> createState() => _CardKeyScreenState();
}

class _CardKeyScreenState extends ConsumerState<CardKeyScreen> {
  bool _busy = false;
  Object? _error;

  Future<void> _register() async {
    final card = await showCardTapSheet(
      context,
      title: 'Tap your contactless card on the back of your phone',
      detail: 'Any contactless bank card. No special crypto card.',
      demoLabel: 'Use demo card',
    );
    if (card == null || !mounted) return;
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      await ref.read(cardKeyStoreProvider).register(card);
      ref.invalidate(cardKeyProvider);
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text(cardRegisteredMessage)));
    } on Object catch (error) {
      if (mounted) setState(() => _error = error);
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _remove(String last4) async {
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (context) => AlertDialog(
        title: const Text('Remove card key?'),
        content: Text('Payments will need only your fingerprint, not a tap of card •••• $last4.'),
        actions: [
          TextButton(onPressed: () => Navigator.pop(context, false), child: const Text('Cancel')),
          FilledButton(onPressed: () => Navigator.pop(context, true), child: const Text('Remove')),
        ],
      ),
    );
    if (confirmed != true) return;
    await ref.read(cardKeyStoreProvider).remove();
    ref.invalidate(cardKeyProvider);
    if (mounted) ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('Card key removed')));
  }

  void _done() => widget.onboarding ? context.go(Routes.home) : context.pop();

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final key = ref.watch(cardKeyProvider);
    final last4 = key.value?.last4;
    return Scaffold(
      appBar: AppBar(
        title: Text(widget.onboarding ? '' : 'Card key'),
        automaticallyImplyLeading: !widget.onboarding,
        actions: [
          if (widget.onboarding && last4 == null) TextButton(onPressed: _done, child: const Text('Skip')),
          const SizedBox(width: 8),
        ],
      ),
      body: switch (key) {
        AsyncError(:final error) => Center(child: ErrorView(error: error)),
        AsyncData() => ListView(
          padding: const EdgeInsets.fromLTRB(20, 8, 20, 32),
          children: [
            CardVisual(last4: last4),
            const SizedBox(height: 28),
            Row(
              children: [
                Expanded(child: Text('Your card is your key', style: theme.textTheme.headlineSmall)),
                if (last4 != null) const AccentTag('ON'),
              ],
            ),
            const SizedBox(height: 8),
            Text(
              last4 == null
                  ? (widget.onboarding
                        ? 'Tap your contactless card to make it your wallet key. '
                              'Every payment then needs a tap of that card, plus your fingerprint. '
                              'No special crypto card: the bank card you already carry works.'
                        : 'Tap the contactless bank card you already carry on the back of your phone. '
                              'No special crypto card. Every payment then needs a tap of that card, '
                              'plus your fingerprint.')
                  : 'Every payment needs a tap of card •••• $last4, then your fingerprint. '
                        'Someone with your phone alone can’t pay.',
              style: theme.textTheme.bodyLarge?.copyWith(color: Brand.muted),
            ),
            const SizedBox(height: 16),
            Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                const Icon(Icons.lock_outline, size: 18, color: Brand.muted),
                const SizedBox(width: 8),
                Expanded(
                  child: Text(
                    'GlobalPay keeps only a one-way fingerprint of the card on this phone. '
                    'The card number is never stored or sent.',
                    style: theme.textTheme.bodySmall,
                  ),
                ),
              ],
            ),
            if (_error != null) ErrorView(error: _error!),
            const SizedBox(height: 28),
            if (last4 == null)
              FilledButton.icon(
                onPressed: _busy ? null : _register,
                icon: const Icon(Icons.contactless_outlined),
                label: const Text('Register card'),
              )
            else ...[
              if (widget.onboarding) ...[
                FilledButton(onPressed: _done, child: const Text('Continue')),
                const SizedBox(height: 8),
              ],
              OutlinedButton(onPressed: () => _remove(last4), child: const Text('Remove key')),
            ],
          ],
        ),
        _ => const Center(child: CircularProgressIndicator()),
      },
    );
  }
}
