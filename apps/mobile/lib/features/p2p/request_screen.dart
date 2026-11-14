import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:globalpay/app/router.dart';
import 'package:globalpay/core/errors/app_exception.dart';
import 'package:globalpay/core/providers.dart';
import 'package:globalpay/core/widgets/common.dart';
import 'package:globalpay/domain/models/p2p.dart';
import 'package:globalpay/features/home/account_providers.dart';
import 'package:globalpay/features/p2p/p2p_support.dart';
import 'package:globalpay/services/tap/tap_services.dart';
import 'package:qr_flutter/qr_flutter.dart';

const requestPollInterval = Duration(seconds: 2);

/// The receiver asks for an amount, then holds the payer's phone to theirs (or shows a QR).
class RequestScreen extends ConsumerStatefulWidget {
  const RequestScreen({super.key});

  @override
  ConsumerState<RequestScreen> createState() => _RequestScreenState();
}

class _RequestScreenState extends ConsumerState<RequestScreen> {
  final _amount = TextEditingController();
  P2pRequest? _request;
  String? _error;
  String? _tapMessage;
  bool _busy = false;
  bool _reading = false;
  Timer? _timer;
  // Kept from initState: `ref` can't be used in dispose.
  late final TapReader _reader;

  @override
  void initState() {
    super.initState();
    _reader = ref.read(tapReaderProvider);
  }

  @override
  void dispose() {
    _timer?.cancel();
    unawaited(_reader.stop());
    _amount.dispose();
    super.dispose();
  }

  Future<void> _create() async {
    final units = parseUsdc(_amount.text);
    if (units == null) {
      setState(() => _error = 'Enter an amount in USDC');
      return;
    }
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      final request = await ref.read(p2pRepositoryProvider).create(units);
      if (!mounted) return;
      setState(() => _request = request);
      _poll();
      unawaited(_readTaps());
    } on Object catch (error) {
      if (mounted) setState(() => _error = describeError(error));
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  /// Reads the other phone until one answers properly, or the request moves on (e.g. a QR scan).
  Future<void> _readTaps() async {
    final reader = _reader;
    if (!await reader.isAvailable() || !mounted) return;
    setState(() => _reading = true);
    while (mounted && _request?.status == P2pStatus.created) {
      final request = _request!;
      try {
        final answer = await reader.read(request.challenge!);
        final tapped = await ref.read(p2pRepositoryProvider).tap(request.id, deviceId: answer.deviceId, signature: answer.signature);
        if (mounted) setState(() => _request = tapped);
      } on AppException catch (error) {
        if (error.code == 'tap_cancelled' || !mounted) break;
        setState(() => _tapMessage = error.message);
      } on Object catch (error) {
        if (!mounted) break;
        setState(() => _tapMessage = describeError(error));
      }
    }
    if (mounted) setState(() => _reading = false);
  }

  Future<void> _poll() async {
    _timer?.cancel();
    final current = _request;
    if (current == null || current.status.isFinal) return;
    try {
      final request = await ref.read(p2pRepositoryProvider).get(current.id);
      if (!mounted) return;
      setState(() => _request = request);
      if (request.status != P2pStatus.created) unawaited(_reader.stop());
      if (request.status == P2pStatus.completed) ref.invalidate(balanceProvider);
      if (request.status.isFinal) return;
    } on Object {
      // Keep trying: a dropped connection shouldn't end the screen.
    }
    _timer = Timer(requestPollInterval, _poll);
  }

  Future<void> _cancel() async {
    final request = _request;
    if (request == null) return;
    try {
      final cancelled = await ref.read(p2pRepositoryProvider).cancel(request.id);
      if (mounted) setState(() => _request = cancelled);
    } on Object catch (error) {
      if (mounted) setState(() => _error = describeError(error));
    }
  }

  @override
  Widget build(BuildContext context) {
    final request = _request;
    return Scaffold(
      appBar: AppBar(title: const Text('Request money')),
      body: ListView(padding: const EdgeInsets.all(16), children: request == null ? _form(context) : _waiting(context, request)),
    );
  }

  List<Widget> _form(BuildContext context) => [
    Text('How much should they pay you?', style: Theme.of(context).textTheme.bodyLarge),
    const SizedBox(height: 16),
    TextField(
      key: const Key('request-amount'),
      controller: _amount,
      autofocus: true,
      keyboardType: const TextInputType.numberWithOptions(decimal: true),
      decoration: InputDecoration(labelText: 'Amount', suffixText: 'USDC', errorText: _error, border: const OutlineInputBorder()),
    ),
    const SizedBox(height: 24),
    FilledButton(
      onPressed: _busy ? null : _create,
      style: FilledButton.styleFrom(minimumSize: const Size.fromHeight(52)),
      child: const Text('Request'),
    ),
  ];

  List<Widget> _waiting(BuildContext context, P2pRequest request) {
    final theme = Theme.of(context);
    final (title, detail) = switch (request.status) {
      P2pStatus.created => ('Hold their phone to the back of yours', _reading ? 'Or let them scan this code.' : 'Let them scan this code.'),
      P2pStatus.senderIdentified => ('Waiting for them to approve', 'They see your name and the amount on their phone.'),
      P2pStatus.approving || P2pStatus.submitted => ('Payment on its way', 'This takes a few seconds.'),
      P2pStatus.completed => ('Received ${request.amount.format()}', 'The USDC is in your wallet.'),
      P2pStatus.declined => ('They declined', 'No money moved.'),
      P2pStatus.expired => ('Request expired', 'No money moved. Start a new request.'),
      P2pStatus.cancelled => ('Request cancelled', 'No money moved.'),
      P2pStatus.failed => ('Payment failed', request.failureReason ?? 'No money moved.'),
    };
    return [
      Text(request.amount.format(), textAlign: TextAlign.center, style: theme.textTheme.displaySmall),
      const SizedBox(height: 8),
      Text(title, key: const Key('request-status'), textAlign: TextAlign.center, style: theme.textTheme.titleLarge),
      const SizedBox(height: 4),
      Text(detail, textAlign: TextAlign.center, style: theme.textTheme.bodyMedium),
      if (request.status == P2pStatus.created && request.challenge != null) ...[
        if (_reading) const Padding(padding: EdgeInsets.all(16), child: Icon(Icons.contactless, size: 72)),
        Center(
          child: Container(
            color: Colors.white,
            padding: const EdgeInsets.all(12),
            child: QrImageView(data: encodeRequestQr(request.id, request.challenge!), size: 220),
          ),
        ),
        if (_tapMessage != null)
          Padding(
            padding: const EdgeInsets.only(top: 12),
            child: Text(_tapMessage!, textAlign: TextAlign.center, style: TextStyle(color: theme.colorScheme.error)),
          ),
      ],
      if (request.senderAddress != null && !request.status.isFinal)
        Padding(padding: const EdgeInsets.only(top: 12), child: DetailRow('From', shortAddress(request.senderAddress!))),
      if (_error != null) Text(_error!, style: TextStyle(color: theme.colorScheme.error)),
      const SizedBox(height: 24),
      if (!request.status.isFinal && !request.status.isSending)
        OutlinedButton(onPressed: _cancel, child: const Text('Cancel request')),
      if (request.status.isFinal) FilledButton(onPressed: () => context.go(Routes.home), child: const Text('Done')),
    ];
  }
}
