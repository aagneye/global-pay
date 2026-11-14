import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:globalpay/app/router.dart';
import 'package:globalpay/core/providers.dart';
import 'package:globalpay/core/widgets/common.dart';
import 'package:globalpay/domain/models/onramp.dart';
import 'package:globalpay/features/home/account_providers.dart';

/// How often to check an order that isn't final yet.
const onrampPollInterval = Duration(seconds: 3);

/// Follows an Add-money order. It checks again as soon as the app comes back from the checkout page.
class OnrampStatusScreen extends ConsumerStatefulWidget {
  const OnrampStatusScreen({super.key, required this.orderId, this.checkoutUrl});

  final String orderId;

  /// To reopen the checkout while the order waits for payment. Absent when opened from history.
  final Uri? checkoutUrl;

  @override
  ConsumerState<OnrampStatusScreen> createState() => _OnrampStatusScreenState();
}

class _OnrampStatusScreenState extends ConsumerState<OnrampStatusScreen> with WidgetsBindingObserver {
  OnrampOrder? _order;
  Object? _error;
  Timer? _timer;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    _poll();
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    _timer?.cancel();
    super.dispose();
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    // Back from the checkout tab: check now rather than at the next tick.
    if (state == AppLifecycleState.resumed && !(_order?.status.isTerminal ?? false)) {
      _timer?.cancel();
      _poll();
    }
  }

  Future<void> _poll() async {
    try {
      final order = await ref.read(onrampRepositoryProvider).get(widget.orderId);
      if (!mounted) return;
      setState(() {
        _order = order;
        _error = null;
      });
      if (order.status.isTerminal) {
        ref.invalidate(balanceProvider);
        ref.invalidate(depositsProvider);
        return;
      }
    } on Object catch (error) {
      if (!mounted) return;
      setState(() => _error = error);
    }
    _timer = Timer(onrampPollInterval, _poll);
  }

  @override
  Widget build(BuildContext context) {
    final order = _order;
    final theme = Theme.of(context);
    return Scaffold(
      appBar: AppBar(title: const Text('Add money')),
      body: order == null
          ? Center(child: _error == null ? const CircularProgressIndicator() : ErrorView(error: _error!))
          : ListView(
              padding: const EdgeInsets.all(16),
              children: [
                _Headline(order: order),
                const SizedBox(height: 16),
                Card(
                  child: Padding(
                    padding: const EdgeInsets.all(16),
                    child: Column(
                      children: [
                        DetailRow('You pay', order.fiatAmount.format()),
                        if (order.tokenAmount != null)
                          DetailRow(order.status == OnrampStatus.completed ? 'You got' : 'You get', order.tokenAmount!.format()),
                        if (order.failureReason != null) DetailRow('Reason', order.failureReason!),
                      ],
                    ),
                  ),
                ),
                if (order.transaction != null)
                  ListTile(
                    contentPadding: EdgeInsets.zero,
                    leading: const Icon(Icons.link),
                    title: const Text('Delivery transaction'),
                    subtitle: Text(shortAddress(order.transaction!.hash)),
                    trailing: IconButton(
                      tooltip: 'Copy explorer link',
                      icon: const Icon(Icons.copy),
                      onPressed: () => copyToClipboard(context, order.transaction!.url, label: 'Link copied'),
                    ),
                  ),
                if (_error != null)
                  Text('Reconnecting… ${describeError(_error!)}', style: theme.textTheme.bodySmall?.copyWith(color: theme.colorScheme.error)),
                const SizedBox(height: 16),
                if (order.status == OnrampStatus.created && widget.checkoutUrl != null)
                  OutlinedButton(
                    onPressed: () => ref.read(checkoutLauncherProvider)(widget.checkoutUrl!),
                    child: const Text('Open checkout again'),
                  ),
                if (order.status.isTerminal)
                  FilledButton(onPressed: () => context.go(Routes.home), child: const Text('Done')),
              ],
            ),
    );
  }
}

class _Headline extends StatelessWidget {
  const _Headline({required this.order});

  final OnrampOrder order;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final (icon, color, title, detail) = switch (order.status) {
      OnrampStatus.created => (
        Icons.open_in_browser,
        theme.colorScheme.tertiary,
        'Waiting for your payment',
        "Finish paying on the checkout page, then come back here.",
      ),
      OnrampStatus.pending => (
        Icons.hourglass_top,
        theme.colorScheme.tertiary,
        'Payment received',
        'Your USDC is on its way. This usually takes a few minutes.',
      ),
      OnrampStatus.completed => (
        Icons.check_circle,
        theme.colorScheme.primary,
        'Added ${order.tokenAmount?.format() ?? ''}'.trim(),
        'The USDC is in your wallet.',
      ),
      OnrampStatus.failed => (Icons.cancel, theme.colorScheme.error, 'Payment failed', 'No money moved.'),
      OnrampStatus.expired => (Icons.timer_off, theme.colorScheme.error, 'Not paid in time', 'No money moved. Start again from Add money.'),
    };
    return Column(
      children: [
        Icon(icon, size: 64, color: color),
        const SizedBox(height: 8),
        Text(title, key: const Key('onramp-headline'), style: theme.textTheme.headlineSmall, textAlign: TextAlign.center),
        const SizedBox(height: 4),
        Text(detail, style: theme.textTheme.bodyMedium, textAlign: TextAlign.center),
      ],
    );
  }
}
