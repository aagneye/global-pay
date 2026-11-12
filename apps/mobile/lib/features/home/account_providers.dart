import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:globalpay/core/providers.dart';
import 'package:globalpay/domain/models/money.dart';
import 'package:globalpay/domain/models/payment.dart';
import 'package:globalpay/features/auth/session_controller.dart';

/// The wallet's USDC balance and the token's address. Refresh with `ref.invalidate(balanceProvider)`.
final balanceProvider = FutureProvider.autoDispose<({TokenAmount amount, String token})>((ref) async {
  await ref.watch(sessionProvider.future);
  return ref.read(accountRepositoryProvider).balance();
});

/// Payments, newest first.
final historyProvider = FutureProvider.autoDispose<List<Payment>>((ref) async {
  await ref.watch(sessionProvider.future);
  return ref.read(accountRepositoryProvider).history();
});
