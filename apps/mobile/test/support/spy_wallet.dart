import 'package:globalpay/services/wallet/dev_wallet_service.dart';

/// The dev wallet, recording the typed data it's asked to sign.
class SpyWallet extends DevWalletService {
  SpyWallet({required super.store, super.importKey});

  final signedTypedData = <Map<String, Object?>>[];

  @override
  Future<String> signTypedData(Map<String, Object?> typedData) {
    signedTypedData.add(typedData);
    return super.signTypedData(typedData);
  }
}
