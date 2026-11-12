import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:globalpay/core/widgets/common.dart';
import 'package:globalpay/domain/models/kyc.dart';
import 'package:globalpay/features/auth/session_controller.dart';
import 'package:globalpay/features/kyc/kyc_controller.dart';

/// Identity verification. The demo's mock provider approves at tier 1; the router then opens home.
class KycScreen extends ConsumerStatefulWidget {
  const KycScreen({super.key});

  @override
  ConsumerState<KycScreen> createState() => _KycScreenState();
}

class _KycScreenState extends ConsumerState<KycScreen> {
  bool _busy = false;
  Object? _error;

  Future<void> _run(Future<void> Function() action) async {
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      await action();
    } on Object catch (error) {
      if (mounted) setState(() => _error = error);
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final kyc = ref.watch(kycProvider);
    final controller = ref.read(kycProvider.notifier);
    final status = kyc.value?.status;

    final (description, action, label) = switch (status) {
      KycStatus.pending => ('Your verification is being checked.', controller.refresh, 'Check status'),
      KycStatus.rejected => ('Your verification was not approved. You can try again.', controller.verify, 'Try again'),
      _ => (
        'Before you can pay, we need to verify your identity. '
            'In this demo a mock provider approves you straight away, with demo limits.',
        controller.verify,
        'Continue',
      ),
    };

    return Scaffold(
      appBar: AppBar(
        title: const Text('Verify your identity'),
        actions: [
          TextButton(onPressed: () => ref.read(sessionProvider.notifier).signOut(), child: const Text('Sign out')),
        ],
      ),
      body: SafeArea(
        child: Padding(
          padding: const EdgeInsets.all(24),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              Text(description, style: theme.textTheme.bodyLarge),
              if (kyc.hasError && _error == null) ErrorView(error: kyc.error!, onRetry: () => _run(controller.refresh)),
              if (_error != null) ErrorView(error: _error!),
              const Spacer(),
              FilledButton(
                onPressed: _busy ? null : () => _run(action),
                child: _busy
                    ? const SizedBox.square(dimension: 20, child: CircularProgressIndicator(strokeWidth: 2))
                    : Text(label),
              ),
            ],
          ),
        ),
      ),
    );
  }
}
