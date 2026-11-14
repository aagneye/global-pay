import 'dart:convert';
import 'dart:typed_data';

import 'package:blockchain_utils/blockchain_utils.dart';
import 'package:globalpay/domain/models/quote.dart';
import 'package:globalpay/services/wallet/near/borsh.dart';
import 'package:globalpay/services/wallet/near/near_keys.dart';

/// NEP-366's signing prefix: 2^30 + 366, so a signed delegate action can never be replayed as a transaction.
const delegateActionPrefix = 1073742190;

/// A `FunctionCall` action (borsh enum index 2).
class NearFunctionCall {
  const NearFunctionCall({required this.methodName, required this.args, required this.gas, required this.deposit});

  final String methodName;

  /// The call's arguments as bytes (UTF-8 JSON for NEP-141 calls).
  final List<int> args;
  final BigInt gas;

  /// Yoctonear attached.
  final BigInt deposit;
}

/// A NEP-366 `DelegateAction`: the actions [senderId] wants run on [receiverId], which a relayer wraps in its
/// own transaction and pays the gas for.
class DelegateAction {
  const DelegateAction({
    required this.senderId,
    required this.receiverId,
    required this.actions,
    required this.nonce,
    required this.maxBlockHeight,
    required this.publicKey,
  });

  /// The delegate action for [payment]: one `ft_transfer_call`, with its arguments as JSON in a fixed key order
  /// (`receiver_id`, `amount`, `msg`), so the backend can rebuild the same bytes.
  ///
  /// Throws a [FormatException] when a number or the public key is malformed.
  factory DelegateAction.fromPayment(NearPayment payment) => DelegateAction(
    senderId: payment.signerId,
    receiverId: payment.receiverId,
    actions: [
      NearFunctionCall(
        methodName: payment.methodName,
        args: transferCallArgsBytes(payment.args),
        gas: parseDecimal(payment.gas, 'gas'),
        deposit: parseDecimal(payment.deposit, 'deposit'),
      ),
    ],
    nonce: parseDecimal(payment.nonce, 'nonce'),
    maxBlockHeight: parseDecimal(payment.maxBlockHeight, 'maxBlockHeight'),
    publicKey: parseNearPublicKey(payment.publicKey),
  );

  final String senderId;
  final String receiverId;
  final List<NearFunctionCall> actions;
  final BigInt nonce;
  final BigInt maxBlockHeight;

  /// The raw 32-byte ed25519 public key.
  final List<int> publicKey;

  /// `borsh(DelegateAction)`.
  Uint8List serialize() {
    final writer = BorshWriter()
      ..string(senderId)
      ..string(receiverId)
      ..u32(actions.length);
    for (final action in actions) {
      writer
        ..u8(2) // Action::FunctionCall
        ..string(action.methodName)
        ..bytes(action.args)
        ..u64(action.gas)
        ..u128(action.deposit);
    }
    writer
      ..u64(nonce)
      ..u64(maxBlockHeight);
    writeEd25519PublicKey(writer, publicKey);
    return writer.toBytes();
  }

  /// What the wallet signs: `sha256(u32 delegateActionPrefix ‖ borsh(DelegateAction))`.
  Uint8List digest() {
    final writer = BorshWriter()
      ..u32(delegateActionPrefix)
      ..fixedBytes(serialize());
    return Uint8List.fromList(QuickCrypto.sha256Hash(writer.toBytes()));
  }

  /// `borsh(SignedDelegate { delegate_action, signature })` with an ed25519 [signature] (64 bytes).
  Uint8List signedBytes(List<int> signature) {
    if (signature.length != 64) throw ArgumentError.value(signature.length, 'signature', 'must be 64 bytes');
    final writer = BorshWriter()
      ..fixedBytes(serialize())
      ..u8(0) // KeyType::ED25519
      ..fixedBytes(signature);
    return writer.toBytes();
  }
}

/// The UTF-8 JSON of `ft_transfer_call`'s arguments, keys in this order: `receiver_id`, `amount`, `msg`.
List<int> transferCallArgsBytes(NearTransferCallArgs args) =>
    utf8.encode(jsonEncode({'receiver_id': args.receiverId, 'amount': args.amount, 'msg': args.msg}));

final _decimal = RegExp(r'^(0|[1-9][0-9]*)$');

/// A non-negative decimal integer string, as NEAR's JSON sends u64 and u128 values.
BigInt parseDecimal(String value, String name) {
  if (!_decimal.hasMatch(value)) throw FormatException('Not a decimal number: $name', value);
  return BigInt.parse(value);
}
