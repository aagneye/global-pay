import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:globalpay/core/providers.dart';
import 'package:globalpay/domain/models/money.dart';
import 'package:globalpay/domain/models/onramp.dart';
import 'package:globalpay/domain/models/p2p.dart';
import 'package:globalpay/domain/models/payment.dart';
import 'package:globalpay/features/auth/session_controller.dart';

/// The wallet's USDC balance and the token's address. Refresh with `ref.invalidate(balanceProvider)`.
final balanceProvider = FutureProvider.autoDispose<({TokenAmount amount, String token})>((ref) async {
  await ref.watch(sessionProvider.future);
  return ref.read(accountRepositoryProvider).balance();
});

/// Deposits, newest first. None on the NEAR rail, which doesn't watch deposits.
final depositsProvider = FutureProvider.autoDispose<List<Deposit>>((ref) async {
  await ref.watch(sessionProvider.future);
  if (ref.read(appConfigProvider).isNear) return const [];
  return ref.read(accountRepositoryProvider).deposits();
});

/// Payments, newest first.
final historyProvider = FutureProvider.autoDispose<List<Payment>>((ref) async {
  await ref.watch(sessionProvider.future);
  return ref.read(accountRepositoryProvider).history();
});

/// Tap-to-pay requests I paid or received, newest first, whatever their status. None on the NEAR rail.
final tapHistoryProvider = FutureProvider.autoDispose<List<P2pRequest>>((ref) async {
  await ref.watch(sessionProvider.future);
  if (ref.read(appConfigProvider).isNear) return const [];
  return ref.read(p2pRepositoryProvider).list();
});
