import 'package:globalpay/core/errors/app_exception.dart';
import 'package:globalpay/core/storage/secure_store.dart';
import 'package:globalpay/services/wallet/local_key_signer.dart';
import 'package:globalpay/services/wallet/wallet_service.dart';

/// Development wallet: a private key kept in the device's secure storage.
///
/// The first `connect` creates a random key, or imports `importKey` (the `DEV_WALLET_PRIVATE_KEY`
/// dart-define) so a demo can use a funded test account. Signing out keeps the key, so the
/// same wallet comes back next time.
///
/// For testnet development and tests only. Never use it with real funds.
class DevWalletService implements WalletService {
  DevWalletService({required SecureStore store, String? importKey})
    : _store = store,
      _importKey = importKey == null || importKey.isEmpty ? null : importKey;

  static const storageKey = 'dev_wallet_private_key';

  final SecureStore _store;
  final String? _importKey;
  LocalKeySigner? _signer;

  @override
  Future<String> connect() async {
    var key = await _store.read(storageKey);
    if (key == null) {
      key = _importKey ?? LocalKeySigner.random().privateKeyHex;
      await _store.write(storageKey, key);
    }
    final signer = LocalKeySigner(key);
    _signer = signer;
    return signer.address;
  }

  @override
  Future<String?> currentAddress() async => _signer?.address;

  @override
  Future<void> disconnect() async => _signer = null;

  @override
  Future<String> signMessage(String message) async => _requireSigner().signMessage(message);

  @override
  Future<String> signTypedData(Map<String, Object?> typedData) async => _requireSigner().signTypedData(typedData);

  LocalKeySigner _requireSigner() =>
      _signer ?? (throw const AppException('wallet_not_connected', 'Sign in to use your wallet'));
}
