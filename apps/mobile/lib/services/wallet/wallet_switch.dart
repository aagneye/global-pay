import 'package:globalpay/core/errors/app_exception.dart';
import 'package:globalpay/core/storage/secure_store.dart';
import 'package:globalpay/services/wallet/wallet_service.dart';

/// The wallets a user can sign in with.
enum WalletKind {
  /// Privy's embedded wallet: email sign-in ([PrivyWalletService]).
  embedded,

  /// A development key on this device ([DevWalletService]). Debug builds only.
  dev,
}

/// The app's [WalletService]: passes each call to the wallet the user signed in with, and remembers
/// that choice so a restored session reconnects the same wallet after a restart.
class WalletSwitch implements WalletService {
  WalletSwitch({required SecureStore store, WalletService? embedded, WalletService? dev})
    : _store = store,
      _embedded = embedded,
      _dev = dev;

  static const kindKey = 'wallet_kind';

  static const notConfigured = AppException(
    'wallet_not_configured',
    "Sign-in isn't set up in this build of GlobalPay.",
  );

  final SecureStore _store;
  final WalletService? _embedded;
  final WalletService? _dev;
  WalletKind? _kind;

  /// The wallets this build offers, embedded first.
  List<WalletKind> get available => [if (_embedded != null) WalletKind.embedded, if (_dev != null) WalletKind.dev];

  /// Uses [kind] from now on, including after a restart. Call it before [connect] when signing in.
  Future<void> use(WalletKind kind) async {
    if (_walletFor(kind) == null) throw notConfigured;
    _kind = kind;
    await _store.write(kindKey, kind.name);
  }

  /// The wallet chosen at sign-in; on a fresh start, the saved choice (or the first one available).
  @override
  Future<String> connect() async {
    var kind = _kind;
    if (kind == null) {
      final saved = WalletKind.values.asNameMap()[await _store.read(kindKey)];
      kind = saved != null && _walletFor(saved) != null ? saved : available.firstOrNull;
      if (kind == null) throw notConfigured;
      _kind = kind;
    }
    return _walletFor(kind)!.connect();
  }

  @override
  Future<String?> currentAddress() async {
    final kind = _kind;
    return kind == null ? null : _walletFor(kind)!.currentAddress();
  }

  @override
  Future<void> disconnect() async {
    final kind = _kind;
    _kind = null;
    await _store.delete(kindKey);
    if (kind != null) await _walletFor(kind)!.disconnect();
  }

  @override
  Future<String> signMessage(String message) async => _active().signMessage(message);

  @override
  Future<String> signTypedData(Map<String, Object?> typedData) async => _active().signTypedData(typedData);

  WalletService _active() {
    final kind = _kind ?? (throw const AppException('wallet_not_connected', 'Sign in to use your wallet'));
    return _walletFor(kind)!;
  }

  WalletService? _walletFor(WalletKind kind) => switch (kind) {
    WalletKind.embedded => _embedded,
    WalletKind.dev => _dev,
  };
}
