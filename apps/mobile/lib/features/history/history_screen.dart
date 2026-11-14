import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:globalpay/app/router.dart';
import 'package:globalpay/core/widgets/common.dart';
import 'package:globalpay/domain/models/onramp.dart';
import 'package:globalpay/domain/models/p2p.dart';
import 'package:globalpay/domain/models/payment.dart';
import 'package:globalpay/features/home/account_providers.dart';

class HistoryScreen extends ConsumerWidget {
  const HistoryScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final payments = ref.watch(historyProvider);
    final deposits = ref.watch(depositsProvider);
    final taps = ref.watch(tapHistoryProvider);

    Future<void> refresh() async {
      ref.invalidate(historyProvider);
      ref.invalidate(depositsProvider);
      ref.invalidate(tapHistoryProvider);
      await ref.read(historyProvider.future);
    }

    return Scaffold(
      appBar: AppBar(title: const Text('History')),
      body: RefreshIndicator(
        onRefresh: refresh,
        child: switch ((payments, deposits, taps)) {
          (AsyncError(:final error), _, _) || (_, AsyncError(:final error), _) || (_, _, AsyncError(:final error)) =>
            ListView(children: [ErrorView(error: error, onRetry: refresh)]),
          (AsyncData(value: final paid), AsyncData(value: final received), AsyncData(value: final tapped)) => switch (
              historyItems(payments: paid, deposits: received, taps: tapped)) {
            [] => ListView(
              children: const [
                Padding(
                  padding: EdgeInsets.all(32),
                  child: Center(child: Text('No payments yet.')),
                ),
              ],
            ),
            final items => ListView(
              padding: const EdgeInsets.all(8),
              children: [
                for (final item in items)
                  switch (item) {
                    Payment() => PaymentTile(payment: item),
                    Deposit() => DepositTile(deposit: item),
                    P2pRequest() => TapPaymentTile(request: item),
                    _ => const SizedBox.shrink(),
                  },
              ],
            ),
          },
          _ => const Center(child: CircularProgressIndicator()),
        },
      ),
    );
  }
}

/// History's rows, newest first: payments, deposits, and tap payments that moved money (sent or completed).
/// The receiver's wallet also sees a tap payment's transfer as a deposit: it shows once, as the tap payment.
List<Object> historyItems({
  required List<Payment> payments,
  required List<Deposit> deposits,
  required List<P2pRequest> taps,
}) {
  final moved = [
    for (final request in taps)
      if (request.status.isSending || request.status == P2pStatus.completed) request,
  ];
  final tapTransfers = {
    for (final request in moved)
      if (request.transaction case final tx?) tx.hash.toLowerCase(),
  };
  final dated = [
    for (final payment in payments) (at: payment.createdAt, item: payment as Object),
    for (final deposit in deposits)
      if (!tapTransfers.contains(deposit.transaction.hash.toLowerCase())) (at: deposit.createdAt, item: deposit),
    for (final request in moved) (at: request.createdAt, item: request),
  ]..sort((a, b) => b.at.compareTo(a.at));
  return [for (final entry in dated) entry.item];
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

/// USDC that came in: from Add money, or from another wallet. Tap to copy the explorer link.
class DepositTile extends StatelessWidget {
  const DepositTile({super.key, required this.deposit});

  final Deposit deposit;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final date = MaterialLocalizations.of(context).formatShortDate(deposit.createdAt.toLocal());
    final fromOnramp = deposit.onrampOrderId != null;
    return ListTile(
      onTap: () => copyToClipboard(context, deposit.transaction.url, label: 'Link copied'),
      leading: CircleAvatar(child: Icon(fromOnramp ? Icons.add_card : Icons.south_west)),
      title: Text(fromOnramp ? 'Added money' : 'Received'),
      subtitle: Text(fromOnramp ? date : '$date · from ${shortAddress(deposit.from)}'),
      trailing: Text('+${deposit.amount.format()}', style: theme.textTheme.titleSmall?.copyWith(color: theme.colorScheme.primary)),
    );
  }
}

/// A tap payment: "Paid Somchai Coffee" or "Received from 0x15d3…6A65". Tap to copy the explorer link.
class TapPaymentTile extends StatelessWidget {
  const TapPaymentTile({super.key, required this.request});

  final P2pRequest request;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final date = MaterialLocalizations.of(context).formatShortDate(request.createdAt.toLocal());
    final received = request.isReceiver;
    final title = switch (request.senderAddress) {
      _ when !received => 'Paid ${request.recipientName}',
      final sender? => 'Received from ${shortAddress(sender)}',
      null => 'Received',
    };
    final link = request.transaction?.url;
    return ListTile(
      onTap: link == null ? null : () => copyToClipboard(context, link, label: 'Link copied'),
      leading: const CircleAvatar(child: Icon(Icons.contactless)),
      title: Text(title, maxLines: 1, overflow: TextOverflow.ellipsis),
      subtitle: Text(request.status.isSending ? '$date · Sending' : date),
      trailing: Text(
        received ? '+${request.amount.format()}' : request.amount.format(),
        style: theme.textTheme.titleSmall?.copyWith(color: received ? theme.colorScheme.primary : null),
      ),
    );
  }
}
