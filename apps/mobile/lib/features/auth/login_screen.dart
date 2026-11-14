import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:globalpay/app/theme.dart';
import 'package:globalpay/core/errors/app_exception.dart';
import 'package:globalpay/core/providers.dart';
import 'package:globalpay/core/widgets/common.dart';
import 'package:globalpay/features/auth/session_controller.dart';
import 'package:globalpay/services/wallet/privy_wallet_service.dart';
import 'package:globalpay/services/wallet/wallet_switch.dart';

/// Sign-in. With Privy configured: email, then the emailed code, which opens (or creates) the user's
/// embedded wallet. Debug builds also offer the dev wallet. Either way the wallet then signs the
/// backend's Sign-In with Ethereum message, and the router moves on once a session exists.
/// On the NEAR rail (SETTLEMENT_RAIL=near) the only option is the NEAR testnet wallet, which signs a NEP-413 message.
class LoginScreen extends ConsumerStatefulWidget {
  const LoginScreen({super.key});

  @override
  ConsumerState<LoginScreen> createState() => _LoginScreenState();
}

enum _Step { email, code }

enum _Action { sendCode, verify, dev, near }

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

  /// NEAR rail: the session controller signs in with the NEAR wallet (NEP-413).
  Future<void> _signInWithNearWallet() => _run(_Action.near, () => ref.read(sessionProvider.notifier).signIn());

  /// The button's text, or a spinner while its action runs.
  Widget _label(String text, _Action action) => _busy == action
      ? const SizedBox.square(dimension: 20, child: CircularProgressIndicator(strokeWidth: 2))
      : Text(text);

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    // The NEAR rail signs in only with the NEAR testnet wallet: no Privy, no dev wallet.
    final near = ref.watch(appConfigProvider).isNear;
    final privy = near ? null : ref.watch(privyWalletProvider);
    final devWallet = !near && ref.watch(devWalletEnabledProvider);
    return Scaffold(
      body: SafeArea(
        child: LayoutBuilder(
          // Scrolls when the keyboard is up; otherwise fills the screen like a plain column.
          builder: (context, constraints) => SingleChildScrollView(
            padding: const EdgeInsets.fromLTRB(24, 20, 24, 24),
            child: ConstrainedBox(
              constraints: BoxConstraints(minHeight: (constraints.maxHeight - 44).clamp(0, double.infinity)),
              child: IntrinsicHeight(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  children: [
                    const Align(alignment: Alignment.centerLeft, child: Wordmark()),
                    const Spacer(flex: 3),
                    Text(
                      'Pay any\nThai QR\nwith USDC.',
                      style: theme.textTheme.displayMedium?.copyWith(height: 1.02, letterSpacing: -2),
                    ),
                    const SizedBox(height: 20),
                    Text(
                      'Scan a PromptPay code and pay in USDC. The merchant gets baht.',
                      style: theme.textTheme.bodyLarge?.copyWith(color: Brand.muted),
                    ),
                    const Spacer(flex: 2),
                    if (privy != null) ..._emailSignIn(theme, privy),
                    if (privy == null && !devWallet && !near) _notConfigured(theme),
                    if (_error != null) ErrorView(error: _error!),
                    if (devWallet) ..._devWallet(theme, primary: privy == null),
                    if (near) ..._nearWallet(theme),
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
          decoration: const InputDecoration(labelText: 'Email'),
        ),
        const SizedBox(height: 12),
        FilledButton(
          onPressed: busy ? null : () => _sendCode(privy),
          child: _label('Email me a code', _Action.sendCode),
        ),
        const SizedBox(height: 12),
        Text(
          'Your wallet is created for you and secured by Privy. GlobalPay never holds your funds.',
          style: theme.textTheme.bodySmall,
          textAlign: TextAlign.center,
        ),
      ],
      _Step.code => [
        Text('Enter the code we sent to', style: theme.textTheme.bodyMedium?.copyWith(color: Brand.muted)),
        Text(_email, style: theme.textTheme.titleMedium),
        const SizedBox(height: 16),
        TextField(
          key: const Key('email-code'),
          controller: _codeController,
          enabled: !busy,
          keyboardType: TextInputType.number,
          autofillHints: const [AutofillHints.oneTimeCode],
          textInputAction: TextInputAction.done,
          onSubmitted: busy ? null : (_) => _verify(privy),
          decoration: const InputDecoration(labelText: 'Code'),
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
      padding: const EdgeInsets.all(20),
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
      const SizedBox(height: 20),
      Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          const Padding(padding: EdgeInsets.only(top: 1), child: AccentTag('TESTNET')),
          const SizedBox(width: 12),
          Expanded(
            child: Text(
              'The dev wallet is a development key stored on this device. '
              'Signing in signs a message with it; no funds move.',
              style: theme.textTheme.bodySmall,
            ),
          ),
        ],
      ),
      const SizedBox(height: 20),
      primary ? FilledButton(onPressed: onPressed, child: label) : OutlinedButton(onPressed: onPressed, child: label),
    ];
  }

  /// NEAR rail: the only way in.
  List<Widget> _nearWallet(ThemeData theme) => [
    const SizedBox(height: 20),
    Row(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        const Padding(padding: EdgeInsets.only(top: 1), child: AccentTag('TESTNET')),
        const SizedBox(width: 12),
        Expanded(
          child: Text(
            'Your NEAR testnet wallet is a key made and kept on this phone. '
            'Signing in signs a message with it; no funds move.',
            style: theme.textTheme.bodySmall,
          ),
        ),
      ],
    ),
    const SizedBox(height: 20),
    FilledButton(
      onPressed: _busy != null ? null : _signInWithNearWallet,
      child: _label('Continue with NEAR testnet wallet', _Action.near),
    ),
  ];
}
