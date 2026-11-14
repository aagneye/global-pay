import 'package:globalpay/core/errors/app_exception.dart';
import 'package:globalpay/core/storage/secure_store.dart';
import 'package:globalpay/services/tap/tap_services.dart';
import 'package:globalpay/services/wallet/local_key_signer.dart';
import 'package:globalpay/services/wallet/wallet_service.dart';

/// Development wallet: a private key kept on the device.
///
/// The first `connect` creates a random key, or imports `importKey` (the `DEV_WALLET_PRIVATE_KEY`
/// dart-define) so a demo can use a funded test account. Signing out keeps the key, so the
/// same wallet comes back next time.
///
/// With a [vault] (a strong biometric enrolled, or a screen lock on Android 11 and later), the key is
/// stored only encrypted by a hardware key that needs the user's fingerprint (or screen lock) every time:
/// each signature asks for it, and a key stored the old way is moved into the vault. Without one
/// (emulators, tests), the key sits in secure storage as before.
///
/// For testnet development and tests only. Never use it with real funds.
class DevWalletService implements WalletService {
  DevWalletService({required SecureStore store, String? importKey, KeyVault? vault})
    : _store = store,
      _vault = vault,
      _importKey = importKey == null || importKey.isEmpty ? null : importKey;

  static const storageKey = 'dev_wallet_private_key';
  static const sealedKey = 'wallet_key_sealed';
  static const addressKey = 'wallet_address';

  final SecureStore _store;
  final KeyVault? _vault;
  final String? _importKey;
  LocalKeySigner? _signer;
  String? _address;
  String? _sealed;

  @override
  Future<String> connect() async {
    final vault = _vault;
    if (vault != null && await vault.isAvailable()) return _connectSealed(vault);

    var key = await _store.read(storageKey);
    if (key == null) {
      key = _importKey ?? LocalKeySigner.random().privateKeyHex;
      await _store.write(storageKey, key);
    }
    final signer = LocalKeySigner(key);
    _signer = signer;
    return _address = signer.address;
  }

  Future<String> _connectSealed(KeyVault vault) async {
    final sealed = await _store.read(sealedKey);
    final address = await _store.read(addressKey);
    if (sealed != null && address != null) {
      _sealed = sealed;
      return _address = address;
    }
    // First use with the vault: seal the existing key (or a new one), then forget the plain copy.
    final key = await _store.read(storageKey) ?? _importKey ?? LocalKeySigner.random().privateKeyHex;
    final signer = LocalKeySigner(key);
    final newSealed = await vault.seal(key, reason: 'Protect your wallet with your fingerprint');
    await _store.write(sealedKey, newSealed);
    await _store.write(addressKey, signer.address);
    await _store.delete(storageKey);
    _sealed = newSealed;
    return _address = signer.address;
  }

  @override
  Future<String?> currentAddress() async => _address;

  @override
  Future<void> disconnect() async {
    _signer = null;
    _sealed = null;
    _address = null;
  }

  @override
  Future<String> signMessage(String message) async =>
      (await _unlock('Sign in to GlobalPay')).signMessage(message);

  @override
  Future<String> signTypedData(Map<String, Object?> typedData) async =>
      (await _unlock('Approve this payment')).signTypedData(typedData);

  /// The signer for one signature: from the vault (asking for the fingerprint) or from memory.
  Future<LocalKeySigner> _unlock(String reason) async {
    final sealed = _sealed;
    if (sealed != null) return LocalKeySigner(await _vault!.open(sealed, reason: reason));
    return _signer ?? (throw const AppException('wallet_not_connected', 'Sign in to use your wallet'));
  }
}
