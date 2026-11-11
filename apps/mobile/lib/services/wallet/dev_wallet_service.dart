import 'package:globalpay/services/wallet/wallet_service.dart';

/// Development wallet: a locally generated key kept in secure storage.
/// For testnet development and tests only. Never use it with real funds.
class DevWalletService implements WalletService {
  const DevWalletService();

  static const _planned = 'DevWalletService is planned for iteration 5';

  @override
  Future<String> connect() => throw UnimplementedError(_planned);

  @override
  Future<String?> currentAddress() => throw UnimplementedError(_planned);

  @override
  Future<void> disconnect() => throw UnimplementedError(_planned);

  @override
  Future<String> signMessage(String message) => throw UnimplementedError(_planned);

  @override
  Future<String> signTypedData(Map<String, Object?> typedData) =>
      throw UnimplementedError(_planned);
}
