import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:globalpay/app/router.dart';
import 'package:globalpay/core/providers.dart';
import 'package:globalpay/core/widgets/common.dart';
import 'package:globalpay/features/pay/confirm_screen.dart' show parseThb;

/// MoonPay's minimum for THB. The backend enforces it too.
final minimumAddMoney = BigInt.from(800_00);

/// "Add money": the user picks a baht amount; the partner's checkout opens in a Custom Tab.
class AddMoneyScreen extends ConsumerStatefulWidget {
  const AddMoneyScreen({super.key});

  @override
  ConsumerState<AddMoneyScreen> createState() => _AddMoneyScreenState();
}

class _AddMoneyScreenState extends ConsumerState<AddMoneyScreen> {
  final _amount = TextEditingController(text: '800');
  bool _busy = false;
  String? _error;

  @override
  void dispose() {
    _amount.dispose();
    super.dispose();
  }

  Future<void> _continue() async {
    final minor = parseThb(_amount.text);
    if (minor == null || minor < minimumAddMoney) {
      setState(() => _error = 'Enter at least ฿800');
      return;
    }
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      final (:order, :checkoutUrl) = await ref.read(onrampRepositoryProvider).create(minor);
      final opened = await ref.read(checkoutLauncherProvider)(checkoutUrl);
      if (!mounted) return;
      context.pushReplacement(Routes.addMoneyStatus(order.id), extra: checkoutUrl);
      if (!opened) {
        ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text("Couldn't open the checkout page")));
      }
    } on Object catch (error) {
      if (mounted) setState(() => _error = describeError(error));
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Scaffold(
      appBar: AppBar(title: const Text('Add money')),
      body: ListView(
        padding: const EdgeInsets.all(16),
        children: [
          Text('Buy USDC with baht. It goes straight to your wallet.', style: theme.textTheme.bodyLarge),
          const SizedBox(height: 16),
          TextField(
            key: const Key('add-money-amount'),
            controller: _amount,
            keyboardType: const TextInputType.numberWithOptions(decimal: true),
            decoration: InputDecoration(labelText: 'Amount', prefixText: '฿ ', errorText: _error, border: const OutlineInputBorder()),
            onChanged: (_) => setState(() => _error = null),
          ),
          const SizedBox(height: 12),
          Wrap(
            spacing: 8,
            children: [
              for (final preset in ['800', '1500', '3000'])
                ActionChip(label: Text('฿$preset'), onPressed: () => setState(() => _amount.text = preset)),
            ],
          ),
          const SizedBox(height: 24),
          FilledButton(
            onPressed: _busy ? null : _continue,
            style: FilledButton.styleFrom(minimumSize: const Size.fromHeight(52)),
            child: _busy ? const SizedBox.square(dimension: 20, child: CircularProgressIndicator(strokeWidth: 2)) : const Text('Continue to payment'),
          ),
          const SizedBox(height: 16),
          Text(
            'You pay our partner by card or bank transfer on their page. The USDC shows here once it has '
            'arrived in your wallet on-chain.',
            style: theme.textTheme.bodySmall,
          ),
        ],
      ),
    );
  }
}
