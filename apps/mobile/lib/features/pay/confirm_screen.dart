import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:globalpay/app/router.dart';
import 'package:globalpay/core/config/app_config.dart';
import 'package:globalpay/core/errors/app_exception.dart';
import 'package:globalpay/core/providers.dart';
import 'package:globalpay/core/widgets/common.dart';
import 'package:globalpay/domain/models/promptpay_qr.dart';
import 'package:globalpay/domain/models/quote.dart';
import 'package:globalpay/domain/signing/authorization_check.dart';
import 'package:globalpay/domain/signing/near_payment_check.dart';
import 'package:globalpay/features/auth/session_controller.dart';
import 'package:globalpay/services/wallet/wallet_switch.dart';

final _amount = RegExp(r'^\d+(\.\d{1,2})?$');

/// Shown instead of the backend's `near_account_not_found`: a first sign-in's account is still being set up.
const nearAccountSettingUp = AppException(
  'near_account_not_found',
  'Your testnet account is still being set up. Try again in a few seconds.',
);

/// Parses "250", "250.5" or "250.50" baht into satang. Null if invalid or not positive.
BigInt? parseThb(String text) {
  final value = text.trim();
  if (!_amount.hasMatch(value)) return null;
  final [whole, fraction] = [...value.split('.'), ''].take(2).toList();
  final minor = BigInt.parse(whole + fraction.padRight(2, '0'));
  return minor > BigInt.zero ? minor : null;
}

/// Shows the merchant and a 60-second quote, then signs the USDC authorisation and submits it.
class ConfirmScreen extends ConsumerStatefulWidget {
  const ConfirmScreen({super.key, required this.qr});

  final PromptPayQr qr;

  @override
  ConsumerState<ConfirmScreen> createState() => _ConfirmScreenState();
}

class _ConfirmScreenState extends ConsumerState<ConfirmScreen> {
  final _amountText = TextEditingController();
  Quote? _quote;
  Object? _error;
  bool _busy = false;
  Timer? _ticker;

  @override
  void initState() {
    super.initState();
    // A dynamic QR fixes the amount, so quote straight away.
    if (widget.qr.amount != null) WidgetsBinding.instance.addPostFrameCallback((_) => _requestQuote());
    _ticker = Timer.periodic(const Duration(seconds: 1), (_) {
      if (_quote != null && mounted) setState(() {});
    });
  }

  @override
  void dispose() {
    _ticker?.cancel();
    _amountText.dispose();
    super.dispose();
  }

  Future<void> _guarded(Future<void> Function() action) async {
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      await action();
    } on Object catch (error) {
      if (mounted && !cancelledByUser(error)) setState(() => _error = error);
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _requestQuote() => _guarded(() async {
    BigInt? minor;
    if (widget.qr.amount == null) {
      minor = parseThb(_amountText.text);
      if (minor == null) throw const FormatException('Enter an amount in baht, e.g. 120 or 59.50');
    }
    final payer = ref.read(sessionProvider).value!.walletAddress;
    final Quote quote;
    try {
      quote = await ref
          .read(paymentsRepositoryProvider)
          .requestQuote(payer: payer, qrPayload: widget.qr.raw, fiatAmountMinor: minor);
    } on AppException catch (error) {
      // NEAR rail: the new implicit account isn't on chain yet (testnet onboarding is still funding it).
      if (error.code == 'near_account_not_found') throw nearAccountSettingUp;
      rethrow;
    }
    setState(() => _quote = quote);
  });

  Future<void> _pay(Quote quote) => _guarded(() async {
    // Never sign more, to anyone else or on another chain than this screen shows, whatever the backend sent.
    final config = ref.read(appConfigProvider);
    if (config.isNear) return _payOnNear(quote, config);
    checkQuoteAuthorization(
      quote,
      wallet: ref.read(sessionProvider).value!.walletAddress,
      chainId: config.chainId,
      settlement: config.settlementAddress,
      now: DateTime.now(),
    );
    final signature = await ref.read(walletServiceProvider).signTypedData(quote.authorization!.typedData);
    final payment = await ref.read(paymentsRepositoryProvider).submit(quote, signature);
    if (mounted) context.pushReplacement(Routes.status(payment.id));
  });

  /// NEAR rail: check the meta transaction, sign it (the relayer pays the gas), and hand it to the backend.
  Future<void> _payOnNear(Quote quote, AppConfig config) async {
    final wallet = ref.read(nearWalletProvider) ?? (throw WalletSwitch.notConfigured);
    checkNearPayment(
      quote,
      account: ref.read(sessionProvider).value!.walletAddress,
      publicKey: wallet.publicKey ?? (throw const AppException('wallet_not_connected', 'Sign in to use your wallet')),
      usdcContract: config.nearUsdcContract,
      settlementContract: config.nearSettlementContract,
      now: DateTime.now(),
    );
    final signedDelegate = await wallet.signDelegate(quote.nearPayment!);
    final payment = await ref.read(paymentsRepositoryProvider).submitSignedDelegate(quote, signedDelegate);
    if (mounted) context.pushReplacement(Routes.status(payment.id));
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final qr = widget.qr;
    final quote = _quote;
    final left = quote?.timeLeft(DateTime.now()) ?? Duration.zero;
    final expired = quote != null && left == Duration.zero;
    final merchantName =
        qr.merchantName ?? (qr.kind == PromptPayKind.merchant ? 'Biller ${qr.targetId}' : 'PromptPay ${qr.targetId}');

    return Scaffold(
      appBar: AppBar(title: const Text('Confirm payment')),
      body: ListView(
        padding: const EdgeInsets.all(16),
        children: [
          Card(
            child: ListTile(
              leading: Icon(qr.kind == PromptPayKind.merchant ? Icons.storefront : Icons.person),
              title: Text(merchantName),
              subtitle: Text(
                [
                  qr.targetId,
                  if (qr.merchantCity != null) qr.merchantCity!,
                  if (qr.reference1 != null) 'Ref ${qr.reference1}',
                ].join(' · '),
              ),
            ),
          ),
          const SizedBox(height: 16),
          if (qr.amount != null)
            Text(qr.amount!.format(), style: theme.textTheme.displaySmall, textAlign: TextAlign.center)
          else
            TextField(
              key: const Key('amount'),
              controller: _amountText,
              enabled: quote == null && !_busy,
              keyboardType: const TextInputType.numberWithOptions(decimal: true),
              decoration: const InputDecoration(labelText: 'Amount', prefixText: '฿ ', border: OutlineInputBorder()),
              onSubmitted: (_) => _requestQuote(),
            ),
          const SizedBox(height: 16),
          if (quote != null) ...[
            Card(
              child: Padding(
                padding: const EdgeInsets.all(16),
                child: Column(
                  children: [
                    DetailRow('You pay', quote.tokenAmount.format(), emphasis: true),
                    DetailRow('Merchant gets', quote.fiatAmount.format()),
                    DetailRow('Rate', quote.formatRate()),
                    DetailRow('Fee (${quote.spreadBps / 100}%)', quote.feeAmount.format()),
                    const Divider(),
                    DetailRow(
                      'Quote valid for',
                      expired ? 'Expired' : '${left.inMinutes}:${(left.inSeconds % 60).toString().padLeft(2, '0')}',
                    ),
                  ],
                ),
              ),
            ),
            const SizedBox(height: 8),
          ],
          if (_error != null) ErrorView(error: _error!),
          const SizedBox(height: 8),
          if (quote == null || expired)
            FilledButton(
              onPressed: _busy || (qr.amount != null && quote == null && _error == null) ? null : _requestQuote,
              child: _busy
                  ? const _Spinner()
                  : Text(
                      expired
                          ? 'Get a new quote'
                          : qr.amount != null
                          ? 'Try again'
                          : 'Get quote',
                    ),
            )
          else
            FilledButton(
              onPressed: _busy ? null : () => _pay(quote),
              child: _busy ? const _Spinner() : Text('Pay ${quote.tokenAmount.format()}'),
            ),
          const SizedBox(height: 8),
          Text(
            ref.watch(appConfigProvider).isNear
                ? 'Paying asks your wallet to sign a USDC transfer on NEAR testnet for exactly this quote. '
                      'No gas needed: GlobalPay relays it.'
                : 'Paying asks your wallet to sign a USDC authorisation for exactly this quote. '
                      'No gas needed.',
            style: theme.textTheme.bodySmall,
            textAlign: TextAlign.center,
          ),
        ],
      ),
    );
  }
}

class _Spinner extends StatelessWidget {
  const _Spinner();

  @override
  Widget build(BuildContext context) =>
      const SizedBox.square(dimension: 20, child: CircularProgressIndicator(strokeWidth: 2));
}
