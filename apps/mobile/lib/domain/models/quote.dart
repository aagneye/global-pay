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
    this.authorization,
    this.nearPayment,
  });

  /// bytes32 hex. Also the nonce of the USDC authorisation the user signs (EVM).
  final String quoteId;

  /// The paying wallet: a 0x address (EVM) or a NEAR implicit account id.
  final String payer;

  /// The USDC contract the quote is priced in: a 0x address (EVM) or a NEAR account id.
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

  /// What the wallet must sign to pay this quote on the EVM rail. Null on the NEAR rail.
  final AuthorizationToSign? authorization;

  /// What the wallet must sign to pay this quote on the NEAR rail. Null on the EVM rail.
  final NearPayment? nearPayment;

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

/// A NEP-366 meta transaction for the wallet to sign (NEAR rail): `signerId` calls `methodName`
/// (`ft_transfer_call`) on `receiverId` (the USDC contract), and a relayer pays the gas.
/// Numbers are decimal strings, as the backend sends them.
class NearPayment {
  const NearPayment({
    required this.signerId,
    required this.publicKey,
    required this.receiverId,
    required this.methodName,
    required this.args,
    required this.gas,
    required this.deposit,
    required this.nonce,
    required this.maxBlockHeight,
  });

  /// The payer's account (implicit account id).
  final String signerId;

  /// The key that signs, `ed25519:<base58>`.
  final String publicKey;

  /// The USDC contract.
  final String receiverId;
  final String methodName;
  final NearTransferCallArgs args;

  /// Gas for the call.
  final String gas;

  /// Yoctonear attached (`ft_transfer_call` needs exactly 1).
  final String deposit;

  /// The access key's next nonce (u64).
  final String nonce;

  /// The last block height the meta transaction is valid for (u64).
  final String maxBlockHeight;
}

/// `ft_transfer_call` arguments: send [amount] to [receiverId] (the settlement contract) with [msg],
/// the backend-signed quote as JSON.
class NearTransferCallArgs {
  const NearTransferCallArgs({required this.receiverId, required this.amount, required this.msg});

  final String receiverId;

  /// Token base units.
  final String amount;
  final String msg;
}
