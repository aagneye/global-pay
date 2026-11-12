import 'dart:convert';
import 'dart:io';

import 'package:blockchain_utils/blockchain_utils.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:globalpay/services/wallet/local_key_signer.dart';

/// Signatures produced by viem for the same key and data (packages/fixtures/wallet/vectors.json).
final vectors =
    jsonDecode(File('../../packages/fixtures/wallet/vectors.json').readAsStringSync()) as Map<String, dynamic>;

void main() {
  final signer = LocalKeySigner(vectors['privateKey'] as String);

  test('derives the checksummed address', () {
    expect(signer.address, vectors['address']);
  });

  test('signs a Sign-In with Ethereum message exactly like viem', () {
    final personal = vectors['personalSign'] as Map<String, dynamic>;
    expect(signer.signMessage(personal['message'] as String), personal['signature']);
  });

  test('signs USDC ReceiveWithAuthorization typed data exactly like viem', () {
    final typed = vectors['typedData'] as Map<String, dynamic>;
    final data = (typed['data'] as Map).cast<String, Object?>();
    expect('0x${BytesUtils.toHexString(LocalKeySigner.hashTypedData(data))}', typed['hash']);
    expect(signer.signTypedData(data), typed['signature']);
  });

  test('creates distinct random keys', () {
    final a = LocalKeySigner.random();
    final b = LocalKeySigner.random();
    expect(a.privateKeyHex, matches(RegExp(r'^0x[0-9a-f]{64}$')));
    expect(a.address, isNot(b.address));
    expect(LocalKeySigner(a.privateKeyHex).address, a.address);
  });
}
