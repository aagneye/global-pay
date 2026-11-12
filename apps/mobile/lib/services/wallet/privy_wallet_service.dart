import 'package:globalpay/services/wallet/wallet_service.dart';

/// Embedded, non-custodial wallet through the Privy Flutter SDK: users sign in with
/// email or Google and never handle a seed phrase. Needs a Privy app ID.
/// Web3Auth is the fallback provider.
class PrivyWalletService implements WalletService {
  const PrivyWalletService();

  static const _planned = 'PrivyWalletService is planned for iteration 7';

  @override
  Future<String> connect() => throw UnimplementedError(_planned);

  @override
  Future<String?> currentAddress() => throw UnimplementedError(_planned);

  @override
  Future<void> disconnect() => throw UnimplementedError(_planned);

  @override
  Future<String> signMessage(String message) => throw UnimplementedError(_planned);

  @override
  Future<String> signTypedData(Map<String, Object?> typedData) => throw UnimplementedError(_planned);
}
