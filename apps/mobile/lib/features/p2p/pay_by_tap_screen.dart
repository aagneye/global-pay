import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:globalpay/app/router.dart';
import 'package:globalpay/core/providers.dart';
import 'package:globalpay/features/p2p/p2p_support.dart';
import 'package:globalpay/services/tap/tap_services.dart';

/// How long one arming lasts; it's renewed while the screen stays open.
const tapArmDuration = Duration(seconds: 60);
const incomingPollInterval = Duration(seconds: 2);

/// The payer holds their phone to the receiver's. While this screen is open the phone answers taps;
/// it also watches for the request (in case a push notification is slow, or push is off).
class PayByTapScreen extends ConsumerStatefulWidget {
  const PayByTapScreen({super.key});

  @override
  ConsumerState<PayByTapScreen> createState() => _PayByTapScreenState();
}

class _PayByTapScreenState extends ConsumerState<PayByTapScreen> {
  bool? _supported;

  /// Tap to pay is turned off for this phone ("This phone" in the home menu).
  bool _off = false;
  Timer? _poll;
  Timer? _rearm;
  bool _leaving = false;
  // Kept from initState: `ref` can't be used in dispose.
  late final TapCard _card;

  @override
  void initState() {
    super.initState();
    _card = ref.read(tapCardProvider);
    unawaited(_start());
  }

  @override
  void dispose() {
    _poll?.cancel();
    _rearm?.cancel();
    unawaited(_card.disarm());
    super.dispose();
  }

  Future<void> _start() async {
    final deviceId = await ref.read(deviceRegistrationProvider.future);
    final off = deviceId == null && await ref.read(tapToPaySwitchProvider).isOff();
    if (!mounted) return;
    setState(() {
      _supported = deviceId != null;
      _off = off;
    });
    if (deviceId != null) {
      final card = _card;
      await card.arm(tapArmDuration);
      _rearm = Timer.periodic(tapArmDuration - const Duration(seconds: 10), (_) => card.arm(tapArmDuration));
    }
    _check();
  }

  Future<void> _check() async {
    try {
      final incoming = await ref.read(p2pRepositoryProvider).incoming();
      if (!mounted || _leaving) return;
      if (incoming.isNotEmpty) {
        _leaving = true;
        context.pushReplacement(Routes.approve(incoming.first.id));
        return;
      }
    } on Object {
      // Try again shortly.
    }
    if (mounted) _poll = Timer(incomingPollInterval, _check);
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final supported = _supported;
    return Scaffold(
      appBar: AppBar(title: const Text('Pay by tap')),
      body: ListView(
        padding: const EdgeInsets.all(24),
        children: [
          const SizedBox(height: 24),
          Icon(Icons.contactless, size: 96, color: theme.colorScheme.primary),
          const SizedBox(height: 16),
          Text(
            _off
                ? 'Tap to pay is off for this phone'
                : supported == false
                ? "This phone can't pay by tap"
                : 'Hold your phone to theirs',
            key: const Key('tap-headline'),
            textAlign: TextAlign.center,
            style: theme.textTheme.headlineSmall,
          ),
          const SizedBox(height: 8),
          Text(
            _off
                ? 'Turn it back on from "This phone" in the menu, or scan the code on their screen instead.'
                : supported == false
                ? 'Scan the code on their screen instead.'
                : "Back to back, near the top. You'll see who you're paying and approve with your fingerprint.",
            textAlign: TextAlign.center,
            style: theme.textTheme.bodyMedium,
          ),
          if (supported == null) const Padding(padding: EdgeInsets.all(24), child: Center(child: CircularProgressIndicator())),
          const SizedBox(height: 32),
          OutlinedButton.icon(
            onPressed: () => context.pushReplacement(Routes.scan),
            icon: const Icon(Icons.qr_code_scanner),
            label: const Text('Scan their code instead'),
          ),
        ],
      ),
    );
  }
}
