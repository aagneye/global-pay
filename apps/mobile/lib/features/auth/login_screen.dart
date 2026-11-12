import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:globalpay/core/widgets/common.dart';
import 'package:globalpay/features/auth/session_controller.dart';

/// Sign-In with Ethereum with the dev wallet. The router moves on once a session exists.
class LoginScreen extends ConsumerStatefulWidget {
  const LoginScreen({super.key});

  @override
  ConsumerState<LoginScreen> createState() => _LoginScreenState();
}

class _LoginScreenState extends ConsumerState<LoginScreen> {
  bool _busy = false;
  Object? _error;

  Future<void> _signIn() async {
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      await ref.read(sessionProvider.notifier).signIn();
    } on Object catch (error) {
      if (mounted) setState(() => _error = error);
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Scaffold(
      body: SafeArea(
        child: Padding(
          padding: const EdgeInsets.all(24),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              const Spacer(),
              Text('GlobalPay', style: theme.textTheme.displaySmall?.copyWith(color: theme.colorScheme.primary)),
              const SizedBox(height: 8),
              Text('Sign in', style: theme.textTheme.headlineSmall),
              const SizedBox(height: 8),
              Text('Pay any Thai PromptPay QR with USDC. The merchant gets baht.', style: theme.textTheme.bodyLarge),
              const Spacer(),
              Card(
                child: Padding(
                  padding: const EdgeInsets.all(16),
                  child: Text(
                    'Testnet demo: your wallet is a development key stored on this device. '
                    'Signing in signs a message with it; no funds move.',
                    style: theme.textTheme.bodySmall,
                  ),
                ),
              ),
              if (_error != null) ErrorView(error: _error!),
              const SizedBox(height: 16),
              FilledButton(
                onPressed: _busy ? null : _signIn,
                child: _busy
                    ? const SizedBox.square(dimension: 20, child: CircularProgressIndicator(strokeWidth: 2))
                    : const Text('Continue with dev wallet'),
              ),
            ],
          ),
        ),
      ),
    );
  }
}
