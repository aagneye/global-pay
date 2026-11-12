import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:globalpay/core/providers.dart';
import 'package:globalpay/domain/models/session.dart';

/// Who's signed in. Starts by restoring a saved session; null means signed out.
class SessionController extends AsyncNotifier<Session?> {
  @override
  Future<Session?> build() => ref.read(authRepositoryProvider).restore();

  /// Sign-In with Ethereum. Throws on failure and leaves the user signed out, so the
  /// sign-in screen can show the error.
  Future<void> signIn() async {
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
