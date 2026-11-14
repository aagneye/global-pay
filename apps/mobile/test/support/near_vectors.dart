import 'dart:convert';
import 'dart:io';

import 'package:globalpay/domain/models/quote.dart';

/// test/fixtures/near_vectors.json, made by near-api-js (tool/near_vectors.mjs). TEST ONLY keys.
final nearVectors = jsonDecode(File('test/fixtures/near_vectors.json').readAsStringSync()) as Map<String, dynamic>;

/// The test wallet's seed (RFC 8032 test key 1), account id and public key.
final nearKey = nearVectors['key'] as Map<String, dynamic>;
final nearTestSeed = nearKey['seed'] as String;
final nearTestAccount = nearKey['accountId'] as String;
final nearTestPublicKey = nearKey['publicKey'] as String;

/// A `nearPayment` as the API sends it, as the domain model.
NearPayment nearPaymentFromJson(Map<String, dynamic> json) {
  final args = json['args'] as Map<String, dynamic>;
  return NearPayment(
    signerId: json['signerId'] as String,
    publicKey: json['publicKey'] as String,
    receiverId: json['receiverId'] as String,
    methodName: json['methodName'] as String,
    args: NearTransferCallArgs(
      receiverId: args['receiver_id'] as String,
      amount: args['amount'] as String,
      msg: args['msg'] as String,
    ),
    gas: json['gas'] as String,
    deposit: json['deposit'] as String,
    nonce: json['nonce'] as String,
    maxBlockHeight: json['maxBlockHeight'] as String,
  );
}
