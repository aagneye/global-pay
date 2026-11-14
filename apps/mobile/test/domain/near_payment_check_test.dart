import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:globalpay/core/errors/app_exception.dart';
import 'package:globalpay/domain/models/money.dart';
import 'package:globalpay/domain/models/quote.dart';
import 'package:globalpay/domain/signing/authorization_check.dart';
import 'package:globalpay/domain/signing/near_payment_check.dart';

const account = 'd75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a';
const publicKey = 'ed25519:FVen3X669xLzsi6N2V91DoiyzHzg1uAgqiT8jZ9nS96Z';
const usdc = 'usdc.globalpay.testnet';
const settlement = 'settle.globalpay.testnet';
const attacker = 'attacker.testnet';
const quoteId = '0xabababababababababababababababababababababababababababababababab';

final now = DateTime.utc(2026, 11, 14, 12);
final nowMs = now.millisecondsSinceEpoch;

/// The quote JSON the backend signs, as a map to change.
Map<String, Object?> signedQuote() => {
  'quote_id': quoteId,
  'payer': account,
  'token': usdc,
  'token_amount': '7477454',
  'fiat_currency': 'THB',
  'fiat_amount': '25000',
  'merchant_ref_hash': '0xf00693116400736b2592210681da6a3d56654b34f739487ff2dfd42ad12d0efc',
  'expires_at_ms': nowMs + 60000,
};

/// `ft_transfer_call`'s msg: the quote JSON as a string, and the backend's signature.
String msgFor(Map<String, Object?> quote) => jsonEncode({'quote': jsonEncode(quote), 'signature': 'c2lnbmF0dXJl'});

/// The `nearPayment` the backend sends, as JSON to change.
Map<String, dynamic> nearPaymentJson() => {
  'signerId': account,
  'publicKey': publicKey,
  'receiverId': usdc,
  'methodName': 'ft_transfer_call',
  'args': {'receiver_id': settlement, 'amount': '7477454', 'msg': msgFor(signedQuote())},
  'gas': '100000000000000',
  'deposit': '1',
  'nonce': '190000000000001',
  'maxBlockHeight': '187654321',
};

NearPayment nearPayment(Map<String, dynamic> json) => NearPayment(
  signerId: json['signerId'] as String,
  publicKey: json['publicKey'] as String,
  receiverId: json['receiverId'] as String,
  methodName: json['methodName'] as String,
  args: NearTransferCallArgs(
    receiverId: json['args']['receiver_id'] as String,
    amount: json['args']['amount'] as String,
    msg: json['args']['msg'] as String,
  ),
  gas: json['gas'] as String,
  deposit: json['deposit'] as String,
  nonce: json['nonce'] as String,
  maxBlockHeight: json['maxBlockHeight'] as String,
);

Quote quote(NearPayment? payment) => Quote(
  quoteId: quoteId,
  payer: account,
  token: usdc,
  tokenAmount: TokenAmount(symbol: 'USDC', units: BigInt.from(7477454), decimals: 6),
  feeAmount: TokenAmount(symbol: 'USDC', units: BigInt.from(74034), decimals: 6),
  fiatAmount: FiatAmount(currency: FiatCurrency.thb, minor: BigInt.from(25000)),
  rateE8: BigInt.from(3376818073),
  spreadBps: 100,
  merchant: const QuoteMerchant(isMerchant: true, targetId: '099999999999901'),
  expiresAt: now.add(const Duration(seconds: 60)),
  nearPayment: payment,
);

/// A payment with [change] applied to its JSON.
NearPayment tampered(void Function(Map<String, dynamic> json) change) => nearPayment(nearPaymentJson()..apply(change));

/// A payment whose signed quote has [change] applied.
NearPayment tamperedQuote(void Function(Map<String, Object?> quote) change) =>
    tampered((p) => p['args']['msg'] = msgFor(signedQuote()..apply(change)));

extension<T extends Map<Object?, Object?>> on T {
  T apply(void Function(T) change) {
    change(this);
    return this;
  }
}

Matcher refusal(String what) => throwsA(
  isA<AppException>()
      .having((e) => e.code, 'code', authorizationMismatchCode)
      .having((e) => e.message, 'message', allOf(contains('($what)'), contains('Nothing was signed'))),
);

void check(NearPayment? payment, {String? usdcContract = usdc, String? settlementContract = settlement}) =>
    checkNearPayment(
      quote(payment),
      account: account,
      publicKey: publicKey,
      usdcContract: usdcContract,
      settlementContract: settlementContract,
      now: now,
    );

void main() {
  test("accepts the backend's payment for exactly this quote", () {
    check(nearPayment(nearPaymentJson()));
    // The contracts are checked only when the build knows them.
    final otherToken = tampered((p) {
      p['receiverId'] = 'other-usdc.testnet';
      p['args']['msg'] = msgFor(signedQuote()..['token'] = 'other-usdc.testnet');
    });
    check(otherToken, usdcContract: null);
    expect(() => check(otherToken), refusal('the token'));
    check(tampered((p) => p['args']['receiver_id'] = attacker), settlementContract: '');
    check(tampered((p) => p['gas'] = '300000000000000'));
    check(tamperedQuote((q) => q['expires_at_ms'] = nowMs + const Duration(minutes: 15).inMilliseconds));
  });

  test('refuses a quote without a NEAR payment (an EVM quote)', () {
    expect(() => check(null), refusal('the kind of payment'));
  });

  // What a compromised backend could change, and what the refusal names.
  final refusals = <(String, NearPayment Function(), String)>[
    ('another method', () => tampered((p) => p['methodName'] = 'ft_transfer'), 'the kind of payment'),
    ('another token', () => tampered((p) => p['receiverId'] = 'fake-usdc.testnet'), 'the token'),
    ('another recipient', () => tampered((p) => p['args']['receiver_id'] = attacker), 'the recipient'),
    ('more than the quote', () => tampered((p) => p['args']['amount'] = '7477455'), 'the amount'),
    ('an amount that is not a number', () => tampered((p) => p['args']['amount'] = '7477454.0'), 'the amount'),
    ('another signer', () => tampered((p) => p['signerId'] = attacker), 'your wallet'),
    (
      'another key',
      () => tampered((p) => p['publicKey'] = 'ed25519:4zvwRjXUKGfvwnParsHAS3HuSVzV5cA4McphgmoCtajS'),
      'your wallet',
    ),
    ('a bigger deposit', () => tampered((p) => p['deposit'] = '1000000000000000000000000'), 'the deposit'),
    ('no deposit', () => tampered((p) => p['deposit'] = '0'), 'the deposit'),
    ('too much gas', () => tampered((p) => p['gas'] = '300000000000001'), 'the gas'),
    ('no gas', () => tampered((p) => p['gas'] = '0'), 'the gas'),
    ('a nonce that is not a u64', () => tampered((p) => p['nonce'] = '18446744073709551616'), 'the time limit'),
    ('a block height that is not a number', () => tampered((p) => p['maxBlockHeight'] = '-1'), 'the time limit'),
    ('a msg that is not JSON', () => tampered((p) => p['args']['msg'] = 'pay me'), 'the quote'),
    (
      'a msg whose quote is not a string',
      () => tampered((p) => p['args']['msg'] = jsonEncode({'quote': signedQuote(), 'signature': 'c2ln'})),
      'the quote',
    ),
    (
      'a msg without a signature',
      () => tampered((p) => p['args']['msg'] = jsonEncode({'quote': jsonEncode(signedQuote())})),
      'the quote',
    ),
    ('a quote for another payment', () => tamperedQuote((q) => q['quote_id'] = '0x${'cd' * 32}'), 'the payment ID'),
    ('a quote for another payer', () => tamperedQuote((q) => q['payer'] = attacker), 'your wallet'),
    ('a quote in another token', () => tamperedQuote((q) => q['token'] = 'fake-usdc.testnet'), 'the token'),
    ('a quote for another amount', () => tamperedQuote((q) => q['token_amount'] = '1'), 'the amount'),
    ('an expired quote', () => tamperedQuote((q) => q['expires_at_ms'] = nowMs), 'the time limit'),
    (
      'a quote valid for too long',
      () => tamperedQuote((q) => q['expires_at_ms'] = nowMs + const Duration(minutes: 16).inMilliseconds),
      'the time limit',
    ),
    (
      'a quote expiry that is not a number',
      () => tamperedQuote((q) => q['expires_at_ms'] = '$nowMs'),
      'the time limit',
    ),
  ];
  for (final (name, payment, what) in refusals) {
    test('refuses $name', () => expect(() => check(payment()), refusal(what)));
  }
}
