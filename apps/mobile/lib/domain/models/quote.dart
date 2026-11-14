import 'package:globalpay/domain/models/money.dart';

/// A short-lived price quote from the backend for paying a PromptPay QR with USDC.
class Quote {
  const Quote({
    required this.quoteId,
    required this.payer,
    required this.token,
    required this.tokenAmount,
    required this.feeAmount,
    required this.fiatAmount,
    required this.rateE8,
    required this.spreadBps,
    required this.merchant,
    required this.expiresAt,
    required this.authorization,
  });

  /// bytes32 hex. Also the nonce of the USDC authorisation the user signs.
  final String quoteId;
  final String payer;

  /// The USDC contract the quote is priced in.
  final String token;

  /// What the user pays, fee included.
  final TokenAmount tokenAmount;

  /// GlobalPay's fee (the spread), already included in [tokenAmount].
  final TokenAmount feeAmount;

  /// What the merchant receives.
  final FiatAmount fiatAmount;

  /// Mid-market THB per 1 USDC, scaled by 1e8, before the spread.
  final BigInt rateE8;
  final int spreadBps;
  final QuoteMerchant merchant;
  final DateTime expiresAt;

  /// What the wallet must sign to pay this quote.
  final AuthorizationToSign authorization;

  Duration timeLeft(DateTime now) {
    final left = expiresAt.difference(now);
    return left.isNegative ? Duration.zero : left;
  }

  /// e.g. "33.77 THB/USDC".
  String formatRate() =>
      '${formatMinorUnits((rateE8 + BigInt.from(500000)) ~/ BigInt.from(1000000), 2)} '
      '${fiatAmount.currency.code}/${tokenAmount.symbol}';
}

class QuoteMerchant {
  const QuoteMerchant({required this.isMerchant, required this.targetId, this.name, this.city, this.reference});

  /// A registered biller (bill payment), as opposed to a person.
  final bool isMerchant;
  final String targetId;
  final String? name;
  final String? city;
  final String? reference;

  String get displayName => name ?? (isMerchant ? 'Biller $targetId' : 'PromptPay $targetId');
}

/// EIP-712 typed data (USDC ReceiveWithAuthorization) for eth_signTypedData_v4, plus the
/// validity window the backend needs back with the signature.
class AuthorizationToSign {
  const AuthorizationToSign({required this.typedData, required this.validAfter, required this.validBefore});

  final Map<String, Object?> typedData;
  final String validAfter;
  final String validBefore;
}
