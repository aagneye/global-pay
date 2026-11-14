// coverage:ignore-file
// GENERATED CODE - DO NOT MODIFY BY HAND
// ignore_for_file: type=lint, unused_import, invalid_annotation_target, unnecessary_import

import 'package:json_annotation/json_annotation.dart';

import 'near_transfer_call_args.dart';

part 'near_payment.g.dart';

/// NEAR rail: sign this as a NEP-366 delegate action (one FunctionCall), then send the borsh SignedDelegate, base64, as `signedDelegate` to POST /payments. The relayer pays the gas. Absent on the EVM rail.
@JsonSerializable()
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
  
  factory NearPayment.fromJson(Map<String, Object?> json) => _$NearPaymentFromJson(json);
  
  /// The payer's implicit account (the delegate action's sender_id)
  final String signerId;

  /// The payer's key, "ed25519:" + base58
  final String publicKey;

  /// The USDC contract
  final String receiverId;

  /// Always "ft_transfer_call"
  final String methodName;
  final NearTransferCallArgs args;

  /// Gas for the function call
  final String gas;

  /// yoctoNEAR attached: always 1
  final String deposit;

  /// The delegate action's nonce: the access key's nonce + 1
  final String nonce;

  /// The delegate action is void after this block height
  final String maxBlockHeight;

  Map<String, Object?> toJson() => _$NearPaymentToJson(this);
}
