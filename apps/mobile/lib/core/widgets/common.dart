import 'dart:math';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:globalpay/core/errors/app_exception.dart';
import 'package:globalpay/domain/models/money.dart';

/// "0x15d3…6A65"
String shortAddress(String address) =>
    address.length <= 12 ? address : '${address.substring(0, 6)}…${address.substring(address.length - 4)}';

/// A token amount for display: grouped whole units and [fractionDigits] decimals, cut rather than rounded,
/// so it never shows more than the wallet holds. 10000.129999 USDC -> (whole: "10,000", fraction: ".12").
({String whole, String fraction}) displayParts(TokenAmount amount, {int fractionDigits = 2}) {
  final digits = min(fractionDigits, amount.decimals);
  final text = formatMinorUnits(amount.units ~/ BigInt.from(10).pow(amount.decimals - digits), digits);
  final sign = text.startsWith('-') ? '-' : '';
  final unsigned = text.substring(sign.length);
  final dot = unsigned.indexOf('.');
  final whole = dot == -1 ? unsigned : unsigned.substring(0, dot);
  final grouped = whole.replaceAllMapped(RegExp(r'\B(?=(\d{3})+(?!\d))'), (_) => ',');
  return (whole: '$sign$grouped', fraction: dot == -1 ? '' : unsigned.substring(dot));
}

/// A message for any error: the backend's own message for [AppException]s.
String describeError(Object error) => switch (error) {
  AppException(:final message) => message,
  FormatException(:final message) => message,
  _ => 'Something went wrong. Please try again.',
};

/// An error with an optional retry button.
class ErrorView extends StatelessWidget {
  const ErrorView({super.key, required this.error, this.onRetry});

  final Object error;
  final VoidCallback? onRetry;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Padding(
      padding: const EdgeInsets.all(16),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          Icon(Icons.error_outline, color: theme.colorScheme.error, size: 32),
          const SizedBox(height: 8),
          Text(describeError(error), textAlign: TextAlign.center, style: theme.textTheme.bodyMedium),
          if (onRetry != null) ...[
            const SizedBox(height: 12),
            OutlinedButton(onPressed: onRetry, child: const Text('Try again')),
          ],
        ],
      ),
    );
  }
}

/// Copies [text] and confirms with a snack bar.
Future<void> copyToClipboard(BuildContext context, String text, {String label = 'Copied'}) async {
  await Clipboard.setData(ClipboardData(text: text));
  if (context.mounted) {
    ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(label), duration: const Duration(seconds: 2)));
  }
}

/// A label and value on one line, e.g. "Rate      33.77 THB/USDC".
class DetailRow extends StatelessWidget {
  const DetailRow(this.label, this.value, {super.key, this.emphasis = false});

  final String label;
  final String value;
  final bool emphasis;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final style = emphasis ? theme.textTheme.titleMedium : theme.textTheme.bodyMedium;
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 4),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Expanded(
            child: Text(label, style: theme.textTheme.bodyMedium?.copyWith(color: theme.colorScheme.outline)),
          ),
          const SizedBox(width: 12),
          Flexible(
            child: Text(value, textAlign: TextAlign.end, style: style),
          ),
        ],
      ),
    );
  }
}
