import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:globalpay/core/providers.dart';
import 'package:globalpay/core/widgets/common.dart';
import 'package:globalpay/features/auth/session_controller.dart';
import 'package:globalpay/features/home/account_providers.dart';
import 'package:qr_flutter/qr_flutter.dart';

/// EIP-681 link to send [token] (an ERC-20) to [recipient] on [chainId]. Wallets that scan it
/// prefill a USDC transfer to this account.
String eip681TransferLink({required String token, required int chainId, required String recipient}) =>
    'ethereum:$token@$chainId/transfer?address=$recipient';

class ReceiveScreen extends ConsumerWidget {
  const ReceiveScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final theme = Theme.of(context);
    final config = ref.watch(appConfigProvider);
    final address = ref.watch(sessionProvider).value?.walletAddress ?? '';
    final balance = ref.watch(balanceProvider);

    return Scaffold(
      appBar: AppBar(title: const Text('Receive USDC')),
      body: ListView(
        padding: const EdgeInsets.all(24),
        children: [
          Text(
            'Send USDC on chain ${config.chainId} to this address. Other tokens or networks will be lost.',
            style: theme.textTheme.bodyMedium,
          ),
          const SizedBox(height: 24),
          Center(
            child: switch (balance) {
              AsyncData(:final value) => Container(
                color: Colors.white,
                padding: const EdgeInsets.all(12),
                child: QrImageView(
                  data: eip681TransferLink(token: value.token, chainId: config.chainId, recipient: address),
                  size: 220,
                ),
              ),
              AsyncError(:final error) => ErrorView(error: error, onRetry: () => ref.invalidate(balanceProvider)),
              _ => const SizedBox.square(dimension: 244, child: Center(child: CircularProgressIndicator())),
            },
          ),
          const SizedBox(height: 24),
          SelectableText(address, textAlign: TextAlign.center, style: theme.textTheme.bodyLarge),
          const SizedBox(height: 12),
          OutlinedButton.icon(
            onPressed: () => copyToClipboard(context, address, label: 'Address copied'),
            icon: const Icon(Icons.copy),
            label: const Text('Copy address'),
          ),
        ],
      ),
    );
  }
}
