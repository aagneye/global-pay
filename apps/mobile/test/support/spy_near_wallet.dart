import 'package:globalpay/domain/models/quote.dart';
import 'package:globalpay/services/wallet/near/near_wallet_service.dart';

/// The NEAR wallet, recording each payment it's asked to sign.
class SpyNearWallet extends NearWalletService {
  SpyNearWallet({required super.store, super.importSeed});

  final signedPayments = <NearPayment>[];
  final signedMessages = <String>[];

  @override
  Future<String> signDelegate(NearPayment payment, {String reason = 'Approve this payment'}) {
    signedPayments.add(payment);
    return super.signDelegate(payment, reason: reason);
  }

  @override
  Future<String> signNep413(
    String message,
    List<int> nonce,
    String recipient, {
    String reason = 'Sign in to GlobalPay',
  }) {
    signedMessages.add(message);
    return super.signNep413(message, nonce, recipient, reason: reason);
  }
}
