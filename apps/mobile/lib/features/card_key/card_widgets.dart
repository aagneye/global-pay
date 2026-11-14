import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:globalpay/app/theme.dart';
import 'package:globalpay/core/errors/app_exception.dart';
import 'package:globalpay/core/providers.dart';
import 'package:globalpay/core/widgets/common.dart';
import 'package:globalpay/services/card_key/card_reader.dart';

/// The card key as a card: black, the wordmark, and the card's last 4. [last4] null draws an outline, before
/// a card is registered.
class CardVisual extends StatelessWidget {
  const CardVisual({super.key, this.last4});

  final String? last4;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final ghost = last4 == null;
    const soft = Color(0x99FFFFFF);
    final ink = ghost ? Brand.muted : Brand.paper;
    return AspectRatio(
      aspectRatio: 1.586,
      child: Container(
        padding: const EdgeInsets.fromLTRB(24, 22, 24, 22),
        decoration: BoxDecoration(
          color: ghost ? Brand.paper : null,
          borderRadius: const BorderRadius.all(Radius.circular(24)),
          border: ghost ? Border.all(color: Brand.line, width: 1.5) : null,
          gradient: ghost
              ? null
              : const LinearGradient(
                  begin: Alignment.topLeft,
                  end: Alignment.bottomRight,
                  colors: [Color(0xFF242424), Brand.ink],
                ),
        ),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              children: [
                Wordmark(size: 20, color: ink),
                const Spacer(),
                Icon(Icons.contactless_outlined, color: ghost ? Brand.muted : soft, size: 26),
              ],
            ),
            const Spacer(),
            // The chip.
            Container(
              width: 40,
              height: 30,
              decoration: BoxDecoration(
                color: ghost ? Brand.mist : const Color(0xFF3A3A3A),
                borderRadius: const BorderRadius.all(Radius.circular(6)),
              ),
            ),
            const SizedBox(height: 18),
            Row(
              crossAxisAlignment: CrossAxisAlignment.end,
              children: [
                Text('Card key', style: theme.textTheme.labelLarge?.copyWith(color: ghost ? Brand.muted : soft)),
                const Spacer(),
                Text(
                  '•••• ${last4 ?? '····'}',
                  key: const Key('card-last4'),
                  style: theme.textTheme.titleMedium?.copyWith(
                    color: ink,
                    letterSpacing: 1.5,
                    fontFeatures: const [FontFeature.tabularFigures()],
                  ),
                ),
              ],
            ),
          ],
        ),
      ),
    );
  }
}

/// A pulsing contactless mark with a yellow dot.
class _ContactlessPulse extends StatefulWidget {
  const _ContactlessPulse();

  @override
  State<_ContactlessPulse> createState() => _ContactlessPulseState();
}

class _ContactlessPulseState extends State<_ContactlessPulse> with SingleTickerProviderStateMixin {
  late final _pulse = AnimationController(vsync: this, duration: const Duration(milliseconds: 1400))
    ..repeat(reverse: true);

  @override
  void dispose() {
    _pulse.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return ScaleTransition(
      scale: Tween(begin: 0.92, end: 1.06).animate(CurvedAnimation(parent: _pulse, curve: Curves.easeInOut)),
      child: Container(
        width: 120,
        height: 120,
        decoration: const BoxDecoration(color: Brand.mist, shape: BoxShape.circle),
        child: Stack(
          alignment: Alignment.center,
          children: [
            const Icon(Icons.contactless_outlined, size: 56, color: Brand.ink),
            Positioned(
              top: 24,
              right: 28,
              child: Container(
                width: 10,
                height: 10,
                decoration: const BoxDecoration(color: Brand.accent, shape: BoxShape.circle),
              ),
            ),
          ],
        ),
      ),
    );
  }
}

/// Asks for a card tap in a bottom sheet: reads it over NFC, or, on a testnet build without NFC (the emulator),
/// offers the demo card with [demoLabel]. Returns the card, or null if the user cancels.
Future<CardTap?> showCardTapSheet(
  BuildContext context, {
  required String title,
  String? detail,
  required String demoLabel,
}) => showModalBottomSheet<CardTap>(
  context: context,
  isScrollControlled: true,
  backgroundColor: Brand.paper,
  shape: const RoundedRectangleBorder(borderRadius: BorderRadius.vertical(top: Radius.circular(28))),
  builder: (context) => _CardTapSheet(title: title, detail: detail, demoLabel: demoLabel),
);

class _CardTapSheet extends ConsumerStatefulWidget {
  const _CardTapSheet({required this.title, required this.detail, required this.demoLabel});

  final String title;
  final String? detail;
  final String demoLabel;

  @override
  ConsumerState<_CardTapSheet> createState() => _CardTapSheetState();
}

class _CardTapSheetState extends ConsumerState<_CardTapSheet> {
  late final CardReader _reader;

  /// Whether this phone can read cards; null while checking.
  bool? _nfc;
  Object? _error;

  @override
  void initState() {
    super.initState();
    _reader = ref.read(cardReaderProvider);
    _listen();
  }

  @override
  void dispose() {
    unawaited(_reader.stop());
    super.dispose();
  }

  Future<void> _listen() async {
    final available = await _reader.isAvailable();
    if (!mounted) return;
    setState(() {
      _nfc = available;
      _error = null;
    });
    if (!available) return;
    try {
      final card = await _reader.read();
      if (mounted) Navigator.pop(context, card);
    } on AppException catch (error) {
      if (error.code != 'tap_cancelled' && mounted) setState(() => _error = error);
    } catch (error) {
      // A platform error (e.g. NFC switched off mid-session) must still show a message and "Try again".
      if (mounted) setState(() => _error = error);
    }
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    // The demo card is for testnets only.
    final demo = _nfc == false && ref.watch(appConfigProvider).isTestnet;
    return SafeArea(
      child: Padding(
        padding: const EdgeInsets.fromLTRB(24, 28, 24, 16),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            const _ContactlessPulse(),
            const SizedBox(height: 24),
            Text(widget.title, style: theme.textTheme.headlineSmall, textAlign: TextAlign.center),
            const SizedBox(height: 8),
            Text(
              _nfc == false && !demo
                  ? "This phone can't read cards. Turn on NFC and try again."
                  : widget.detail ?? 'Hold it flat against the back of the phone.',
              style: theme.textTheme.bodyMedium?.copyWith(color: Brand.muted),
              textAlign: TextAlign.center,
            ),
            if (_error != null) ...[
              const SizedBox(height: 12),
              Text(
                describeError(_error!),
                style: theme.textTheme.bodyMedium?.copyWith(color: Brand.danger),
                textAlign: TextAlign.center,
              ),
            ],
            const SizedBox(height: 24),
            if (demo)
              SizedBox(
                width: double.infinity,
                child: FilledButton.icon(
                  onPressed: () => Navigator.pop(context, demoCardTap),
                  icon: const Icon(Icons.contactless_outlined),
                  label: Text(widget.demoLabel),
                ),
              )
            else if (_error != null && _nfc == true)
              SizedBox(
                width: double.infinity,
                child: FilledButton(onPressed: _listen, child: const Text('Try again')),
              ),
            const SizedBox(height: 8),
            SizedBox(
              width: double.infinity,
              child: TextButton(onPressed: () => Navigator.pop(context), child: const Text('Cancel')),
            ),
          ],
        ),
      ),
    );
  }
}
