import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:globalpay/app/router.dart';
import 'package:globalpay/core/providers.dart';
import 'package:globalpay/core/widgets/common.dart';
import 'package:globalpay/domain/models/payment.dart';
import 'package:globalpay/features/home/account_providers.dart';

/// How often to check a payment that isn't final yet.
const statusPollInterval = Duration(seconds: 1);

/// Follows a payment until it's SETTLED, REFUNDED or FAILED.
class PaymentStatusScreen extends ConsumerStatefulWidget {
  const PaymentStatusScreen({super.key, required this.paymentId});

  final String paymentId;

  @override
  ConsumerState<PaymentStatusScreen> createState() => _PaymentStatusScreenState();
}

class _PaymentStatusScreenState extends ConsumerState<PaymentStatusScreen> {
  Payment? _payment;
  Object? _error;
  Timer? _timer;

  @override
  void initState() {
    super.initState();
    _poll();
  }

  @override
  void dispose() {
    _timer?.cancel();
    super.dispose();
  }

  Future<void> _poll() async {
    try {
      final payment = await ref.read(paymentsRepositoryProvider).get(widget.paymentId);
      if (!mounted) return;
      setState(() {
        _payment = payment;
        _error = null;
      });
      if (payment.status.isTerminal) {
        ref.invalidate(balanceProvider);
        ref.invalidate(historyProvider);
        return;
      }
    } on Object catch (error) {
      if (!mounted) return;
      setState(() => _error = error);
    }
    // Keep polling after errors too: a dropped connection shouldn't end the screen.
    _timer = Timer(statusPollInterval, _poll);
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final payment = _payment;
    return Scaffold(
      appBar: AppBar(title: const Text('Payment status')),
      body: payment == null
          ? Center(child: _error == null ? const CircularProgressIndicator() : ErrorView(error: _error!))
          : ListView(
              padding: const EdgeInsets.all(16),
              children: [
                _Headline(payment: payment),
                const SizedBox(height: 16),
                Card(
                  child: Padding(
                    padding: const EdgeInsets.all(16),
                    child: Column(
                      children: [
                        DetailRow('Merchant', payment.merchantName),
                        DetailRow('Merchant gets', payment.fiatAmount.format()),
                        DetailRow('You paid', payment.tokenAmount.format()),
                        if (payment.failureReason != null) DetailRow('Reason', payment.failureReason!),
                      ],
                    ),
                  ),
                ),
                const SizedBox(height: 16),
                _Steps(status: payment.status),
                const SizedBox(height: 16),
                for (final (label, tx) in [
                  ('Payment', payment.payTx),
                  ('Settlement', payment.settleTx),
                  ('Refund', payment.refundTx),
                ])
                  if (tx != null)
                    ListTile(
                      contentPadding: EdgeInsets.zero,
                      leading: const Icon(Icons.link),
                      title: Text('$label transaction'),
                      subtitle: Text(shortAddress(tx.hash)),
                      trailing: IconButton(
                        tooltip: 'Copy explorer link',
                        icon: const Icon(Icons.copy),
                        onPressed: () => copyToClipboard(context, tx.url, label: 'Link copied'),
                      ),
                    ),
                if (_error != null)
                  Text(
                    'Reconnecting… ${describeError(_error!)}',
                    style: theme.textTheme.bodySmall?.copyWith(color: theme.colorScheme.error),
                  ),
                const SizedBox(height: 16),
                if (payment.status.isTerminal)
                  FilledButton(onPressed: () => context.go(Routes.home), child: const Text('Done')),
              ],
            ),
    );
  }
}

class _Headline extends StatelessWidget {
  const _Headline({required this.payment});

  final Payment payment;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final (icon, color, text) = switch (payment.status) {
      PaymentStatus.settled => (Icons.check_circle, theme.colorScheme.primary, 'Paid'),
      PaymentStatus.refunded => (Icons.undo, theme.colorScheme.error, 'Refunded'),
      PaymentStatus.failed => (Icons.cancel, theme.colorScheme.error, 'Payment failed'),
      _ => (Icons.hourglass_top, theme.colorScheme.tertiary, 'Processing'),
    };
    final detail = switch (payment.status) {
      PaymentStatus.settled => 'The merchant received ${payment.fiatAmount.format()}.',
      PaymentStatus.refunded => 'The merchant payout failed, so your USDC was returned.',
      PaymentStatus.failed => 'No money moved.',
      _ => 'This usually takes a few seconds.',
    };
    return Column(
      children: [
        Icon(icon, size: 64, color: color),
        const SizedBox(height: 8),
        Text(text, key: const Key('status-headline'), style: theme.textTheme.headlineSmall),
        const SizedBox(height: 4),
        Text(detail, style: theme.textTheme.bodyMedium, textAlign: TextAlign.center),
      ],
    );
  }
}

/// The payment's progress: sent, received on-chain, merchant paid, then paid or refunded.
class _Steps extends StatelessWidget {
  const _Steps({required this.status});

  final PaymentStatus status;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final order = [PaymentStatus.submitted, PaymentStatus.paid, PaymentStatus.payoutPending, PaymentStatus.settled];
    final reached = status == PaymentStatus.refunded ? 3 : order.indexOf(status);
    final steps = [
      'Payment sent',
      'USDC received on-chain',
      'Paying the merchant in baht',
      status == PaymentStatus.refunded ? 'USDC refunded' : 'Merchant paid',
    ];
    if (status == PaymentStatus.failed) {
      return const SizedBox.shrink();
    }
    return Column(
      children: [
        for (final (index, label) in steps.indexed)
          ListTile(
            dense: true,
            contentPadding: EdgeInsets.zero,
            leading: Icon(
              index <= reached ? Icons.check_circle : Icons.radio_button_unchecked,
              color: index <= reached ? theme.colorScheme.primary : theme.colorScheme.outline,
            ),
            title: Text(label),
          ),
      ],
    );
  }
}
