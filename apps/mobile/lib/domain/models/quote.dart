import 'package:globalpay/domain/models/money.dart';
import 'package:globalpay/domain/models/promptpay_qr.dart';

/// A short-lived price quote from the backend for paying a PromptPay QR with USDC.
class Quote {
  const Quote({
    required this.quoteId,
    required this.payer,
    required this.tokenAmount,
    required this.fiatAmount,
    required this.rateE8,
    required this.spreadBps,
    required this.merchant,
    required this.expiresAt,
  });

  /// bytes32 hex. Also the nonce of the USDC authorisation the user signs.
  final String quoteId;
  final String payer;
  final TokenAmount tokenAmount;
  final FiatAmount fiatAmount;

  /// Fiat major units per 1 token, scaled by 1e8, before the spread.
  final BigInt rateE8;
  final int spreadBps;
  final PromptPayQr merchant;
  final DateTime expiresAt;

  Duration timeLeft(DateTime now) {
    final left = expiresAt.difference(now);
    return left.isNegative ? Duration.zero : left;
  }
}

/// EIP-712 typed data (USDC ReceiveWithAuthorization) for eth_signTypedData_v4.
class AuthorizationToSign {
  const AuthorizationToSign(this.typedData);

  final Map<String, Object?> typedData;
}
