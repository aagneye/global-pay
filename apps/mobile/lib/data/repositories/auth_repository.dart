import 'package:blockchain_utils/blockchain_utils.dart';
import 'package:globalpay/core/errors/app_exception.dart';
import 'package:globalpay/data/api/api_client.dart';
import 'package:globalpay/data/api/generated/export.dart' as dto;
import 'package:globalpay/data/session_store.dart';
import 'package:globalpay/domain/models/session.dart';
import 'package:globalpay/services/wallet/near/near_wallet_service.dart';
import 'package:globalpay/services/wallet/wallet_service.dart';

/// Sign-in: the backend writes the message, the wallet signs it, the backend returns a token.
///
/// On EVM that's Sign-In with Ethereum with [wallet]. On the NEAR rail ([near] set) it's a NEP-413 signature
/// by the NEAR wallet, for [nearRecipient], over the message and the backend's 32-byte nonce.
class AuthRepository {
  const AuthRepository({
    required this.api,
    required this.wallet,
    required this.sessions,
    this.near,
    this.nearRecipient = 'globalpay.local',
  });

  final ApiClient api;
  final WalletService wallet;
  final SessionStore sessions;

  /// The NEAR rail's wallet, or null on EVM.
  final NearWalletService? near;

  /// The NEP-413 recipient the backend expects (its SIWE_DOMAIN).
  final String nearRecipient;

  /// The saved session, if it's still valid. Reconnects the wallet so it can sign.
  Future<Session?> restore() async {
    final session = await sessions.load();
    if (session == null) return null;
    final address = await (near?.connect() ?? wallet.connect());
    if (address.toLowerCase() != session.walletAddress.toLowerCase()) {
      // A different wallet than the one that signed in: start over.
      await sessions.clear();
      return null;
    }
    return session;
  }

  Future<Session> signIn() async {
    final near = this.near;
    final address = await (near?.connect() ?? wallet.connect());
    final nonce = await ApiClient.call(() => api.api.auth.createSignInNonce(body: dto.NonceRequest(address: address)));
    final dto.SignInRequest request;
    if (near != null) {
      final nonceBytes = BytesUtils.tryFromHexString(nonce.nonce);
      if (nonceBytes == null || nonceBytes.length != 32) {
        throw const AppException('invalid_nonce', "GlobalPay sent a sign-in request this wallet can't sign.");
      }
      final signature = await near.signNep413(nonce.message, nonceBytes, nearRecipient);
      request = dto.SignInRequest(message: nonce.message, signature: signature, publicKey: near.publicKey);
    } else {
      request = dto.SignInRequest(message: nonce.message, signature: await wallet.signMessage(nonce.message));
    }
    final response = await ApiClient.call(() => api.api.auth.verifySignIn(body: request));
    final session = Session(
      token: response.token,
      expiresAt: response.expiresAt,
      userId: response.user.id,
      walletAddress: address,
    );
    await sessions.save(session);
    return session;
  }

  /// Forgets the session. The dev and NEAR wallets keep their keys, so signing in again gives the same account.
  Future<void> signOut() async {
    await sessions.clear();
    await (near?.disconnect() ?? wallet.disconnect());
  }
}
