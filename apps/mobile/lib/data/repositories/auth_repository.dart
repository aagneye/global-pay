import 'package:globalpay/data/api/api_client.dart';
import 'package:globalpay/data/api/generated/export.dart' as dto;
import 'package:globalpay/data/session_store.dart';
import 'package:globalpay/domain/models/session.dart';
import 'package:globalpay/services/wallet/wallet_service.dart';

/// Sign-In with Ethereum: the backend writes the message, the wallet signs it, the backend returns a token.
class AuthRepository {
  const AuthRepository({required this.api, required this.wallet, required this.sessions});

  final ApiClient api;
  final WalletService wallet;
  final SessionStore sessions;

  /// The saved session, if it's still valid. Reconnects the wallet so it can sign.
  Future<Session?> restore() async {
    final session = await sessions.load();
    if (session == null) return null;
    final address = await wallet.connect();
    if (address.toLowerCase() != session.walletAddress.toLowerCase()) {
      // A different wallet than the one that signed in: start over.
      await sessions.clear();
      return null;
    }
    return session;
  }

  Future<Session> signIn() async {
    final address = await wallet.connect();
    final nonce = await ApiClient.call(() => api.api.auth.createSignInNonce(body: dto.NonceRequest(address: address)));
    final signature = await wallet.signMessage(nonce.message);
    final response = await ApiClient.call(
      () => api.api.auth.verifySignIn(
        body: dto.SignInRequest(message: nonce.message, signature: signature),
      ),
    );
    final session = Session(
      token: response.token,
      expiresAt: response.expiresAt,
      userId: response.user.id,
      walletAddress: address,
    );
    await sessions.save(session);
    return session;
  }

  /// Forgets the session. The dev wallet keeps its key, so signing in again gives the same account.
  Future<void> signOut() async {
    await sessions.clear();
    await wallet.disconnect();
  }
}
