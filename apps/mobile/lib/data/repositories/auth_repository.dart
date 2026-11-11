import 'package:globalpay/data/api/api_client.dart';
import 'package:globalpay/services/wallet/wallet_service.dart';

/// Sign-In with Ethereum: nonce from the backend -> wallet signs -> backend returns a JWT.
class AuthRepository {
  const AuthRepository({required this.api, required this.wallet});

  final ApiClient api;
  final WalletService wallet;

  /// Returns the session token.
  Future<String> signIn() =>
      throw UnimplementedError('Sign-In with Ethereum is planned for iteration 5');

  Future<void> signOut() => throw UnimplementedError('Sign-out is planned for iteration 5');
}
