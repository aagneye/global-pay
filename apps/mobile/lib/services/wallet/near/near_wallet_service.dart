import 'dart:convert';
import 'dart:math';

import 'package:blockchain_utils/blockchain_utils.dart';
import 'package:globalpay/core/errors/app_exception.dart';
import 'package:globalpay/core/storage/secure_store.dart';
import 'package:globalpay/domain/models/quote.dart';
import 'package:globalpay/services/tap/tap_services.dart';
import 'package:globalpay/services/wallet/near/delegate_action.dart';
import 'package:globalpay/services/wallet/near/near_keys.dart';
import 'package:globalpay/services/wallet/signature_gate.dart';

/// The NEAR testnet wallet (SETTLEMENT_RAIL=near): an ed25519 key made on this phone. The account is the key's
/// implicit account (64 hex characters), so there's no account to create and no seed phrase.
///
/// Like the dev wallet, with a [KeyVault] (a strong biometric, or a screen lock on Android 11 and later) the
/// key is stored only sealed by a hardware key, and every signature asks for the fingerprint (or screen lock).
/// Without one, the key sits in secure storage, unless [requireVault] (release builds), which refuses.
///
/// Testnet only.
class NearWalletService {
  NearWalletService({required SecureStore store, KeyVault? vault, bool requireVault = false, String? importSeed})
    : _store = store,
      _vault = vault,
      _requireVault = requireVault,
      _importSeed = importSeed == null || importSeed.isEmpty ? null : importSeed;

  /// The key's 32-byte seed as hex, when there's no vault.
  static const storageKey = 'near_wallet_seed';

  /// The seed sealed by the vault, and the public key it belongs to.
  static const sealedKey = 'near_wallet_seed_sealed';
  static const publicKeyKey = 'near_wallet_public_key';

  final SecureStore _store;
  final KeyVault? _vault;
  final bool _requireVault;
  final String? _importSeed;
  List<int>? _seed;
  String? _sealed;
  List<int>? _publicKey;

  /// Opens the wallet (creating its key on first use) and returns its implicit account id.
  Future<String> connect() async {
    final vault = _vault;
    if (vault != null && await vault.isAvailable()) return _connectSealed(vault);
    if (_requireVault) throw FingerprintGate.unavailable;

    var seedHex = await _store.read(storageKey);
    if (seedHex == null) {
      seedHex = _importSeed ?? _randomSeedHex();
      await _store.write(storageKey, seedHex);
    }
    final seed = _parseSeed(seedHex);
    _seed = seed;
    _sealed = null;
    _publicKey = _publicKeyOf(seed);
    return implicitAccountId(_publicKey!);
  }

  Future<String> _connectSealed(KeyVault vault) async {
    final sealed = await _store.read(sealedKey);
    final publicKey = await _store.read(publicKeyKey);
    if (sealed != null && publicKey != null) {
      _sealed = sealed;
      _seed = null;
      _publicKey = parseNearPublicKey(publicKey);
      return implicitAccountId(_publicKey!);
    }
    // First use with the vault: seal the existing key (or a new one), then forget the plain copy.
    final seedHex = await _store.read(storageKey) ?? _importSeed ?? _randomSeedHex();
    final key = _publicKeyOf(_parseSeed(seedHex));
    final newSealed = await vault.seal(seedHex, reason: 'Protect your wallet with your fingerprint');
    await _store.write(sealedKey, newSealed);
    await _store.write(publicKeyKey, nearPublicKeyString(key));
    await _store.delete(storageKey);
    _sealed = newSealed;
    _seed = null;
    _publicKey = key;
    return implicitAccountId(key);
  }

  /// The connected account (implicit account id), or null when signed out.
  String? get accountId => switch (_publicKey) {
    null => null,
    final key => implicitAccountId(key),
  };

  /// The connected key, `ed25519:<base58>`, or null when signed out.
  String? get publicKey => switch (_publicKey) {
    null => null,
    final key => nearPublicKeyString(key),
  };

  /// Forgets the open key. The stored key stays, so signing in again gives the same account.
  Future<void> disconnect() async {
    _seed = null;
    _sealed = null;
    _publicKey = null;
  }

  /// A NEP-413 signature over [message] with a 32-byte [nonce] for [recipient], as base64.
  Future<String> signNep413(
    String message,
    List<int> nonce,
    String recipient, {
    String reason = 'Sign in to GlobalPay',
  }) async {
    final digest = nep413Digest(message: message, nonce: nonce, recipient: recipient);
    return base64.encode(await _sign(digest, reason));
  }

  /// Signs [payment] as a NEP-366 delegate action and returns `base64(borsh(SignedDelegate))` for the relayer.
  ///
  /// Check the payment against the quote first (`checkNearPayment`): this only refuses a payment for another
  /// account or key, or one it can't encode.
  Future<String> signDelegate(NearPayment payment, {String reason = 'Approve this payment'}) async {
    final key = _publicKey ?? (throw _notConnected);
    final DelegateAction action;
    try {
      action = DelegateAction.fromPayment(payment);
    } on FormatException {
      throw const AppException('invalid_payment', "This payment can't be signed. Nothing was signed.");
    }
    if (!_sameBytes(action.publicKey, key) || payment.signerId != implicitAccountId(key)) {
      throw const AppException('wallet_mismatch', 'This payment is for a different wallet. Nothing was signed.');
    }
    return base64.encode(action.signedBytes(await _sign(action.digest(), reason)));
  }

  /// An ed25519 signature over [digest]: with the key from the vault (asking for the fingerprint) or from memory.
  Future<List<int>> _sign(List<int> digest, String reason) async {
    final key = _publicKey ?? (throw _notConnected);
    final sealed = _sealed;
    final List<int> seed;
    if (sealed != null) {
      seed = _parseSeed(await _vault!.open(sealed, reason: reason));
      // A sealed key that isn't this account's was tampered with: never sign with it.
      if (!_sameBytes(_publicKeyOf(seed), key)) throw _notConnected;
    } else {
      seed = _seed ?? (throw _notConnected);
    }
    return Ed25519Signer.fromKeyBytes(seed).sign(digest);
  }

  static const _notConnected = AppException('wallet_not_connected', 'Sign in to use your wallet');

  static List<int> _publicKeyOf(List<int> seed) => Ed25519PrivateKey.fromBytes(seed).publicKey.compressed.sublist(1);

  static List<int> _parseSeed(String hex) {
    final bytes = BytesUtils.tryFromHexString(hex);
    if (bytes == null || bytes.length != 32) throw _notConnected;
    return bytes;
  }

  static String _randomSeedHex() {
    final random = Random.secure();
    return BytesUtils.toHexString(List<int>.generate(32, (_) => random.nextInt(256)));
  }

  static bool _sameBytes(List<int> a, List<int> b) => BytesUtils.bytesEqual(a, b);
}
