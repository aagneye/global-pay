import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:globalpay/core/providers.dart';
import 'package:globalpay/domain/models/kyc.dart';
import 'package:globalpay/features/auth/session_controller.dart';

/// The signed-in user's KYC state; null when signed out. Reloads when the session changes.
class KycController extends AsyncNotifier<KycState?> {
  @override
  Future<KycState?> build() async {
    final session = await ref.watch(sessionProvider.future);
    if (session == null) return null;
    return ref.read(kycRepositoryProvider).status();
  }

  /// Starts verification, then checks the result. The mock provider approves on that check;
  /// a real one could stay PENDING for a while.
  Future<void> verify() async {
    final repository = ref.read(kycRepositoryProvider);
    state = AsyncData(await repository.start());
    state = AsyncData(await repository.status());
  }

  Future<void> refresh() async {
    state = await AsyncValue.guard(() => ref.read(kycRepositoryProvider).status());
  }
}

final kycProvider = AsyncNotifierProvider<KycController, KycState?>(KycController.new);
