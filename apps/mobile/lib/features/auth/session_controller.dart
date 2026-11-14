import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:globalpay/core/errors/app_exception.dart';
import 'package:globalpay/core/providers.dart';
import 'package:globalpay/domain/models/session.dart';
import 'package:globalpay/services/wallet/wallet_switch.dart';

/// Who's signed in. Starts by restoring a saved session; null means signed out.
class SessionController extends AsyncNotifier<Session?> {
  @override
  Future<Session?> build() async {
    try {
      return await ref.read(authRepositoryProvider).restore();
    } on AppException catch (error) {
      if (error.code != 'wallet_not_connected') rethrow;
      // The wallet's own sign-in ended (e.g. Privy's session expired): sign in again.
      await ref.read(sessionStoreProvider).clear();
      return null;
    }
  }

  /// Sign-In with Ethereum, with [wallet] when given (otherwise the wallet chosen before).
  /// Throws on failure and leaves the user signed out, so the sign-in screen can show the error.
  Future<void> signIn([WalletKind? wallet]) async {
    if (wallet != null) await ref.read(walletSwitchProvider).use(wallet);
    final session = await ref.read(authRepositoryProvider).signIn();
    state = AsyncData(session);
  }

  Future<void> signOut() async {
    await ref.read(authRepositoryProvider).signOut();
    state = const AsyncData(null);
  }

  /// The backend rejected the token (expired or revoked).
  void expire() {
    if (state.value == null) return;
    ref.read(sessionStoreProvider).clear();
    state = const AsyncData(null);
  }
}

final sessionProvider = AsyncNotifierProvider<SessionController, Session?>(SessionController.new);
