import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:globalpay/core/errors/app_exception.dart';
import 'package:globalpay/core/providers.dart';
import 'package:globalpay/core/widgets/common.dart';
import 'package:globalpay/features/auth/session_controller.dart';
import 'package:globalpay/services/wallet/privy_wallet_service.dart';
import 'package:globalpay/services/wallet/wallet_switch.dart';

/// Sign-in. With Privy configured: email, then the emailed code, which opens (or creates) the user's
/// embedded wallet. Debug builds also offer the dev wallet. Either way the wallet then signs the
/// backend's Sign-In with Ethereum message, and the router moves on once a session exists.
class LoginScreen extends ConsumerStatefulWidget {
  const LoginScreen({super.key});

  @override
  ConsumerState<LoginScreen> createState() => _LoginScreenState();
}

enum _Step { email, code }

enum _Action { sendCode, verify, dev }

class _LoginScreenState extends ConsumerState<LoginScreen> {
  final _emailController = TextEditingController();
  final _codeController = TextEditingController();
  var _step = _Step.email;
  var _email = '';

  /// Privy accepted the code; only the backend sign-in is left (e.g. it failed and the user retries).
  var _verified = false;
  _Action? _busy;
  Object? _error;

  @override
  void dispose() {
    _emailController.dispose();
    _codeController.dispose();
    super.dispose();
  }

  Future<void> _run(_Action action, Future<void> Function() body) async {
    setState(() {
      _busy = action;
      _error = null;
    });
    try {
      await body();
    } on Object catch (error) {
      if (mounted && !cancelledByUser(error)) setState(() => _error = error);
    } finally {
      if (mounted) setState(() => _busy = null);
    }
  }

  Future<void> _sendCode(PrivyWalletService privy) => _run(_Action.sendCode, () async {
    final email = _emailController.text.trim();
    await privy.sendEmailCode(email);
    if (!mounted) return;
    setState(() {
      _email = email;
      _step = _Step.code;
      _verified = false;
      _codeController.clear();
    });
  });

  Future<void> _verify(PrivyWalletService privy) => _run(_Action.verify, () async {
    if (!_verified) {
      await privy.verifyEmailCode(email: _email, code: _codeController.text);
      _verified = true;
    }
    await ref.read(sessionProvider.notifier).signIn(WalletKind.embedded);
  });

  void _changeEmail() => setState(() {
    _step = _Step.email;
    _verified = false;
    _error = null;
  });

  Future<void> _signInWithDevWallet() =>
      _run(_Action.dev, () => ref.read(sessionProvider.notifier).signIn(WalletKind.dev));

  /// The button's text, or a spinner while its action runs.
  Widget _label(String text, _Action action) => _busy == action
      ? const SizedBox.square(dimension: 20, child: CircularProgressIndicator(strokeWidth: 2))
      : Text(text);

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final privy = ref.watch(privyWalletProvider);
    final devWallet = ref.watch(devWalletEnabledProvider);
    return Scaffold(
      body: SafeArea(
        child: LayoutBuilder(
          // Scrolls when the keyboard is up; otherwise fills the screen like a plain column.
          builder: (context, constraints) => SingleChildScrollView(
            padding: const EdgeInsets.all(24),
            child: ConstrainedBox(
              constraints: BoxConstraints(minHeight: (constraints.maxHeight - 48).clamp(0, double.infinity)),
              child: IntrinsicHeight(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  children: [
                    const Spacer(),
                    Text('GlobalPay', style: theme.textTheme.displaySmall?.copyWith(color: theme.colorScheme.primary)),
                    const SizedBox(height: 8),
                    Text('Sign in', style: theme.textTheme.headlineSmall),
                    const SizedBox(height: 8),
                    Text(
                      'Pay any Thai PromptPay QR with USDC. The merchant gets baht.',
                      style: theme.textTheme.bodyLarge,
                    ),
                    const Spacer(),
                    if (privy != null) ..._emailSignIn(theme, privy),
                    if (privy == null && !devWallet) _notConfigured(theme),
                    if (_error != null) ErrorView(error: _error!),
                    if (devWallet) ..._devWallet(theme, primary: privy == null),
                  ],
                ),
              ),
            ),
          ),
        ),
      ),
    );
  }

  List<Widget> _emailSignIn(ThemeData theme, PrivyWalletService privy) {
    final busy = _busy != null;
    return switch (_step) {
      _Step.email => [
        TextField(
          key: const Key('email'),
          controller: _emailController,
          enabled: !busy,
          keyboardType: TextInputType.emailAddress,
          autofillHints: const [AutofillHints.email],
          autocorrect: false,
          textInputAction: TextInputAction.send,
          onSubmitted: busy ? null : (_) => _sendCode(privy),
          decoration: const InputDecoration(labelText: 'Email', border: OutlineInputBorder()),
        ),
        const SizedBox(height: 12),
        FilledButton(
          onPressed: busy ? null : () => _sendCode(privy),
          child: _label('Email me a code', _Action.sendCode),
        ),
        const SizedBox(height: 8),
        Text(
          'Your wallet is created for you and secured by Privy. GlobalPay never holds your funds.',
          style: theme.textTheme.bodySmall,
        ),
      ],
      _Step.code => [
        Text('Enter the code we sent to $_email', style: theme.textTheme.bodyLarge),
        const SizedBox(height: 12),
        TextField(
          key: const Key('email-code'),
          controller: _codeController,
          enabled: !busy,
          keyboardType: TextInputType.number,
          autofillHints: const [AutofillHints.oneTimeCode],
          textInputAction: TextInputAction.done,
          onSubmitted: busy ? null : (_) => _verify(privy),
          decoration: const InputDecoration(labelText: 'Code', border: OutlineInputBorder()),
        ),
        const SizedBox(height: 12),
        FilledButton(onPressed: busy ? null : () => _verify(privy), child: _label('Sign in', _Action.verify)),
        Wrap(
          alignment: WrapAlignment.spaceBetween,
          children: [
            TextButton(onPressed: busy ? null : _changeEmail, child: const Text('Use a different email')),
            TextButton(onPressed: busy ? null : () => _sendCode(privy), child: const Text('Send a new code')),
          ],
        ),
      ],
    };
  }

  /// A release build without Privy IDs: there's no wallet to sign in with.
  Widget _notConfigured(ThemeData theme) => Card(
    child: Padding(
      padding: const EdgeInsets.all(16),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(WalletSwitch.notConfigured.message, style: theme.textTheme.titleMedium),
          const SizedBox(height: 8),
          Text(
            'Email sign-in needs the PRIVY_APP_ID and PRIVY_CLIENT_ID dart-defines at build time.',
            style: theme.textTheme.bodySmall,
          ),
        ],
      ),
    ),
  );

  /// Debug builds only. Below the email sign-in, as a secondary option, when Privy is configured.
  List<Widget> _devWallet(ThemeData theme, {required bool primary}) {
    final onPressed = _busy != null ? null : _signInWithDevWallet;
    final label = _label('Continue with dev wallet', _Action.dev);
    return [
      const SizedBox(height: 16),
      Card(
        child: Padding(
          padding: const EdgeInsets.all(16),
          child: Text(
            'Testnet demo: the dev wallet is a development key stored on this device. '
            'Signing in signs a message with it; no funds move.',
            style: theme.textTheme.bodySmall,
          ),
        ),
      ),
      const SizedBox(height: 16),
      primary ? FilledButton(onPressed: onPressed, child: label) : OutlinedButton(onPressed: onPressed, child: label),
    ];
  }
}
