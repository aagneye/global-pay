import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:globalpay/core/errors/app_exception.dart';
import 'package:globalpay/domain/models/money.dart';
import 'package:globalpay/domain/models/p2p.dart';
import 'package:globalpay/domain/models/quote.dart';
import 'package:globalpay/domain/signing/authorization_check.dart';

const wallet = '0x15d34AAf54267DB7D7c367839AAf71A00a2C6A65';
const token = '0x5FbDB2315678afecb367f032d93F642f64180aa3';
const settlement = '0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512';
const receiver = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8';
const attacker = '0x000000000000000000000000000000000000dEaD';
const quoteId = '0xabababababababababababababababababababababababababababababababab';
const chainId = 31337;

final now = DateTime.utc(2026, 11, 14, 12);
final nowSeconds = now.millisecondsSinceEpoch ~/ 1000;

/// What the backend sends: EIP-3009 typed data for [primaryType].
Map<String, Object?> typedData(
  String primaryType, {
  required String to,
  required String value,
  required String nonce,
  required int validFor,
}) => {
  'types': {
    'EIP712Domain': [
      {'name': 'name', 'type': 'string'},
      {'name': 'version', 'type': 'string'},
      {'name': 'chainId', 'type': 'uint256'},
      {'name': 'verifyingContract', 'type': 'address'},
    ],
    primaryType: [
      {'name': 'from', 'type': 'address'},
      {'name': 'to', 'type': 'address'},
      {'name': 'value', 'type': 'uint256'},
      {'name': 'validAfter', 'type': 'uint256'},
      {'name': 'validBefore', 'type': 'uint256'},
      {'name': 'nonce', 'type': 'bytes32'},
    ],
  },
  'primaryType': primaryType,
  'domain': {'name': 'USDC', 'version': '2', 'chainId': chainId, 'verifyingContract': token},
  'message': {
    'from': wallet,
    'to': to,
    'value': value,
    'validAfter': '0',
    'validBefore': '${nowSeconds + validFor}',
    'nonce': nonce,
  },
};

/// A copy of [typed] with [change] applied.
Map<String, Object?> tampered(Map<String, Object?> typed, void Function(Map<String, dynamic> typed) change) {
  final copy = jsonDecode(jsonEncode(typed)) as Map<String, dynamic>;
  change(copy);
  return copy;
}

Matcher refusal(String what) => throwsA(
  isA<AppException>()
      .having((e) => e.code, 'code', authorizationMismatchCode)
      .having((e) => e.message, 'message', allOf(contains('($what)'), contains('Nothing was signed'))),
);

/// Ways a backend could change the typed data, and what the refusal names.
final structureTampering = <String, void Function(Map<String, dynamic>)>{
  'another primary type': (t) => t['primaryType'] = 'Permit',
  'an unknown primary type': (t) => t['primaryType'] = null,
  'an extra type': (t) => t['types']['Permit'] = <Object>[],
  'reordered fields': (t) {
    final fields = t['types'][t['primaryType']] as List;
    final [from, to, ...rest] = fields;
    t['types'][t['primaryType']] = [to, from, ...rest];
  },
  'a field of another type': (t) => (t['types'][t['primaryType']] as List)[2] = {'name': 'value', 'type': 'uint128'},
  'a domain type without the chain': (t) => (t['types']['EIP712Domain'] as List).removeAt(2),
  'a domain with a salt': (t) => t['domain']['salt'] = '0x${'00' * 32}',
  'no message': (t) => t.remove('message'),
};

void main() {
  group('checkQuoteAuthorization', () {
    final valid = typedData('ReceiveWithAuthorization', to: settlement, value: '7477454', nonce: quoteId, validFor: 60);

    Quote quote(Map<String, Object?> typed) => Quote(
      quoteId: quoteId,
      payer: wallet,
      token: token,
      tokenAmount: TokenAmount(symbol: 'USDC', units: BigInt.from(7477454), decimals: 6),
      feeAmount: TokenAmount(symbol: 'USDC', units: BigInt.from(74034), decimals: 6),
      fiatAmount: FiatAmount(currency: FiatCurrency.thb, minor: BigInt.from(25000)),
      rateE8: BigInt.from(3376818073),
      spreadBps: 100,
      merchant: const QuoteMerchant(isMerchant: true, targetId: '099999999999901'),
      expiresAt: now.add(const Duration(seconds: 60)),
      authorization: AuthorizationToSign(typedData: typed, validAfter: '0', validBefore: '${nowSeconds + 60}'),
    );

    void check(Map<String, Object?> typed, {String? settlementAddress = settlement, String signer = wallet}) =>
        checkQuoteAuthorization(
          quote(typed),
          wallet: signer,
          chainId: chainId,
          settlement: settlementAddress,
          now: now,
        );

    test("accepts the backend's authorisation for exactly this quote", () {
      check(valid);
      // Addresses compare whatever their case; numbers may be decimal or hex strings, or ints.
      check(valid, signer: wallet.toLowerCase(), settlementAddress: settlement.toUpperCase().replaceFirst('0X', '0x'));
      check(tampered(valid, (t) => t['domain']['chainId'] = '0x7a69'));
      check(tampered(valid, (t) => t['message']['value'] = 7477454));
      check(tampered(valid, (t) => (t['types'] as Map).remove('EIP712Domain')));
    });

    test('checks the recipient only when the settlement address is known', () {
      final elsewhere = tampered(valid, (t) => t['message']['to'] = attacker);
      expect(() => check(elsewhere), refusal('the recipient'));
      check(elsewhere, settlementAddress: null);
      check(elsewhere, settlementAddress: '');
      expect(
        () => check(tampered(valid, (t) => t['message']['to'] = 'not an address'), settlementAddress: null),
        refusal('the recipient'),
      );
    });

    for (final MapEntry(key: name, value: change) in structureTampering.entries) {
      test('refuses $name', () => expect(() => check(tampered(valid, change)), refusal('the kind of authorisation')));
    }

    test('refuses a transfer instead of a receive', () {
      final transfer = typedData(
        'TransferWithAuthorization',
        to: settlement,
        value: '7477454',
        nonce: quoteId,
        validFor: 60,
      );
      expect(() => check(transfer), refusal('the kind of authorisation'));
    });

    for (final (name, change, what) in <(String, void Function(Map<String, dynamic>), String)>[
      ('another chain', (t) => t['domain']['chainId'] = 1, 'the network'),
      ('a chain ID that is not a number', (t) => t['domain']['chainId'] = 'base', 'the network'),
      ('another token', (t) => t['domain']['verifyingContract'] = attacker, 'the token'),
      ("someone else's wallet", (t) => t['message']['from'] = attacker, 'your wallet'),
      ('another recipient', (t) => t['message']['to'] = attacker, 'the recipient'),
      ('more than the quote', (t) => t['message']['value'] = '7477455', 'the amount'),
      ('a hex amount that is more', (t) => t['message']['value'] = '0xffffffff', 'the amount'),
      ('a negative amount', (t) => t['message']['value'] = -1, 'the amount'),
      ('another nonce', (t) => t['message']['nonce'] = '0x${'cd' * 32}', 'the payment ID'),
      ('an expired authorisation', (t) => t['message']['validBefore'] = '$nowSeconds', 'the time limit'),
      ('one valid for a day', (t) => t['message']['validBefore'] = '${nowSeconds + 86400}', 'the time limit'),
      ('one valid only later', (t) => t['message']['validAfter'] = '${nowSeconds + 30}', 'the time limit'),
      ('a missing expiry', (t) => (t['message'] as Map).remove('validBefore'), 'the time limit'),
    ]) {
      test('refuses $name', () => expect(() => check(tampered(valid, change)), refusal(what)));
    }

    test('refuses when the signed-in wallet is not the payer', () {
      expect(() => check(valid, signer: attacker), refusal('your wallet'));
    });
  });

  group('checkTapAuthorization', () {
    final valid = typedData(
      'TransferWithAuthorization',
      to: receiver,
      value: '5000000',
      nonce: '0x${'77' * 32}',
      validFor: 600,
    );
    final shown = P2pRequest(
      id: 'request_1',
      isReceiver: false,
      status: P2pStatus.senderIdentified,
      token: token,
      amount: TokenAmount(symbol: 'USDC', units: BigInt.from(5000000), decimals: 6),
      recipientName: 'Somchai Coffee',
      recipientVerified: false,
      recipientAddress: receiver,
      expiresAt: now.add(const Duration(minutes: 2)),
      createdAt: now,
      senderAddress: wallet,
    );

    void check(Map<String, Object?> typed, {String signer = wallet}) =>
        checkTapAuthorization(typed, shown, wallet: signer, chainId: chainId, now: now);

    test('accepts the transfer the approve screen shows', () {
      check(valid);
      check(tampered(valid, (t) => t['message']['to'] = receiver.toLowerCase()), signer: wallet.toLowerCase());
    });

    for (final MapEntry(key: name, value: change) in structureTampering.entries) {
      test('refuses $name', () => expect(() => check(tampered(valid, change)), refusal('the kind of authorisation')));
    }

    test('refuses a receive instead of a transfer', () {
      final receive = typedData(
        'ReceiveWithAuthorization',
        to: receiver,
        value: '5000000',
        nonce: '0x${'77' * 32}',
        validFor: 600,
      );
      expect(() => check(receive), refusal('the kind of authorisation'));
    });

    for (final (name, change, what) in <(String, void Function(Map<String, dynamic>), String)>[
      ('another chain', (t) => t['domain']['chainId'] = 8453, 'the network'),
      ('another token', (t) => t['domain']['verifyingContract'] = attacker, 'the token'),
      ("someone else's wallet", (t) => t['message']['from'] = attacker, 'your wallet'),
      ('a recipient the screen does not show', (t) => t['message']['to'] = attacker, 'the recipient'),
      ('more than the screen shows', (t) => t['message']['value'] = '5000001', 'the amount'),
      ('a nonce that is not bytes32', (t) => t['message']['nonce'] = '0x77', 'the payment ID'),
      ('an expired authorisation', (t) => t['message']['validBefore'] = '${nowSeconds - 1}', 'the time limit'),
      ('one valid for years', (t) => t['message']['validBefore'] = '1900000000', 'the time limit'),
    ]) {
      test('refuses $name', () => expect(() => check(tampered(valid, change)), refusal(what)));
    }
  });
}
