import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:globalpay/app/router.dart';
import 'package:globalpay/core/errors/app_exception.dart';
import 'package:globalpay/core/providers.dart';
import 'package:globalpay/core/widgets/common.dart';
import 'package:globalpay/domain/models/p2p.dart';
import 'package:globalpay/domain/signing/authorization_check.dart';
import 'package:globalpay/features/auth/session_controller.dart';
import 'package:globalpay/features/home/account_providers.dart';
import 'package:globalpay/features/p2p/request_screen.dart' show requestPollInterval;

/// The payer reviews who they're paying and how much, then approves with their fingerprint: the wallet
/// signs a USDC transfer built by the backend from the stored request, and the backend relays it.
class ApproveScreen extends ConsumerStatefulWidget {
  const ApproveScreen({super.key, required this.requestId});

  final String requestId;

  @override
  ConsumerState<ApproveScreen> createState() => _ApproveScreenState();
}

class _ApproveScreenState extends ConsumerState<ApproveScreen> {
  P2pRequest? _request;
  Object? _error;
  bool _busy = false;
  Timer? _timer;

  @override
  void initState() {
    super.initState();
    _load();
  }

  @override
  void dispose() {
    _timer?.cancel();
    super.dispose();
  }

  Future<void> _load() async {
    _timer?.cancel();
    try {
      final request = await ref.read(p2pRepositoryProvider).get(widget.requestId);
      if (!mounted) return;
      setState(() {
        _request = request;
        _error = null;
      });
      if (request.status == P2pStatus.completed) ref.invalidate(balanceProvider);
      if (request.status.isSending) _timer = Timer(requestPollInterval, _load);
    } on Object catch (error) {
      if (mounted) setState(() => _error = error);
    }
  }

  Future<void> _approve() async {
    // What the payer saw when they tapped Approve.
    final shown = _request!;
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      final repository = ref.read(p2pRepositoryProvider);
      final typed = await repository.authorization(widget.requestId);
      // Never sign a transfer to anyone else, or for more, than this screen shows, whatever the backend sent.
      checkTapAuthorization(
        typed,
        shown,
        wallet: ref.read(sessionProvider).value!.walletAddress,
        chainId: ref.read(appConfigProvider).chainId,
        now: DateTime.now(),
      );
      final signature = await ref.read(walletServiceProvider).signTypedData(typed);
      final request = await repository.approve(widget.requestId, signature);
      if (!mounted) return;
      setState(() => _request = request);
      _timer = Timer(requestPollInterval, _load);
    } on Object catch (error) {
      if (mounted && !cancelledByUser(error)) setState(() => _error = error);
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _decline() async {
    try {
      final request = await ref.read(p2pRepositoryProvider).decline(widget.requestId);
      if (mounted) setState(() => _request = request);
    } on Object catch (error) {
      if (mounted) setState(() => _error = error);
    }
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final request = _request;
    return Scaffold(
      appBar: AppBar(title: const Text('Approve payment')),
      body: request == null
          ? Center(child: _error == null ? const CircularProgressIndicator() : ErrorView(error: _error!, onRetry: _load))
          : ListView(
              padding: const EdgeInsets.all(16),
              children: [
                Text('Pay', textAlign: TextAlign.center, style: theme.textTheme.titleMedium),
                const SizedBox(height: 4),
                Text(request.amount.format(), key: const Key('approve-amount'), textAlign: TextAlign.center, style: theme.textTheme.displaySmall),
                const SizedBox(height: 16),
                Card(
                  child: Padding(
                    padding: const EdgeInsets.all(16),
                    child: Column(
                      children: [
                        Row(
                          mainAxisAlignment: MainAxisAlignment.center,
                          children: [
                            Flexible(child: Text(request.recipientName, style: theme.textTheme.titleLarge, overflow: TextOverflow.ellipsis)),
                            const SizedBox(width: 6),
                            if (request.recipientVerified) Icon(Icons.verified, color: theme.colorScheme.primary, semanticLabel: 'Verified name'),
                          ],
                        ),
                        const SizedBox(height: 4),
                        Text(
                          request.recipientVerified ? 'Verified name' : 'Name not verified: check it with them',
                          style: theme.textTheme.bodySmall?.copyWith(color: request.recipientVerified ? null : theme.colorScheme.error),
                        ),
                        const SizedBox(height: 8),
                        DetailRow('Wallet', shortAddress(request.recipientAddress)),
                      ],
                    ),
                  ),
                ),
                const SizedBox(height: 16),
                ..._status(context, request),
                if (_error != null)
                  Padding(
                    padding: const EdgeInsets.only(top: 12),
                    child: Text(describeError(_error!), textAlign: TextAlign.center, style: TextStyle(color: theme.colorScheme.error)),
                  ),
              ],
            ),
    );
  }

  List<Widget> _status(BuildContext context, P2pRequest request) {
    final theme = Theme.of(context);
    Widget headline(String text) =>
        Text(text, key: const Key('approve-status'), textAlign: TextAlign.center, style: theme.textTheme.titleLarge);
    return switch (request.status) {
      P2pStatus.senderIdentified when DateTime.now().isAfter(request.expiresAt) => [headline('This request has expired')],
      P2pStatus.senderIdentified => [
        FilledButton.icon(
          onPressed: _busy ? null : _approve,
          icon: const Icon(Icons.fingerprint),
          label: Text(_busy ? 'Approving…' : 'Approve'),
          style: FilledButton.styleFrom(minimumSize: const Size.fromHeight(52)),
        ),
        const SizedBox(height: 8),
        TextButton(onPressed: _busy ? null : _decline, child: const Text('Decline')),
      ],
      P2pStatus.approving || P2pStatus.submitted => [headline('Sending…'), const Padding(padding: EdgeInsets.all(16), child: Center(child: CircularProgressIndicator()))],
      P2pStatus.completed => [
        headline('Paid ${request.amount.format()}'),
        const SizedBox(height: 16),
        FilledButton(onPressed: () => context.go(Routes.home), child: const Text('Done')),
      ],
      P2pStatus.failed => [headline('Payment failed'), Text(request.failureReason ?? '', textAlign: TextAlign.center)],
      P2pStatus.declined => [headline('Declined. No money moved.')],
      P2pStatus.expired => [headline('This request has expired')],
      P2pStatus.cancelled => [headline('They cancelled the request')],
      P2pStatus.created => [headline('Waiting…')],
    };
  }
}
