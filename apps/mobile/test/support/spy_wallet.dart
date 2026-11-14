import 'package:globalpay/core/errors/app_exception.dart';
import 'package:globalpay/services/wallet/dev_wallet_service.dart';

/// The dev wallet, recording the typed data it's asked to sign.
class SpyWallet extends DevWalletService {
  SpyWallet({required super.store, super.importKey});

  final signedTypedData = <Map<String, Object?>>[];

  /// The user backs out of the next signature's fingerprint prompt.
  bool cancelNext = false;

  @override
  Future<String> signTypedData(Map<String, Object?> typedData) {
    if (cancelNext) {
      cancelNext = false;
      throw const AppException('biometric_cancelled', 'Authentication canceled.');
    }
    signedTypedData.add(typedData);
    return super.signTypedData(typedData);
  }
}
