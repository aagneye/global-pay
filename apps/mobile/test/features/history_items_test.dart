import 'package:flutter_test/flutter_test.dart';
import 'package:globalpay/data/repositories/payments_repository.dart' show thb, usdc;
import 'package:globalpay/domain/models/onramp.dart';
import 'package:globalpay/domain/models/p2p.dart';
import 'package:globalpay/domain/models/payment.dart';
import 'package:globalpay/features/history/history_screen.dart';

final day = DateTime.utc(2026, 11, 14);

TxLink tx(String byte) => TxLink(hash: '0x${byte * 32}', url: 'https://explorer.test/tx/0x${byte * 32}');

Payment payment(String id, int hour) => Payment(
  id: id,
  quoteId: '0x01',
  status: PaymentStatus.settled,
  fiatAmount: thb('25000'),
  tokenAmount: usdc('7477454'),
  merchantName: 'GLOBALPAY TEST CAFE',
  createdAt: day.add(Duration(hours: hour)),
);

Deposit deposit(String id, int hour, TxLink transaction) => Deposit(
  id: id,
  amount: usdc('5000000'),
  from: '0x15d34AAf54267DB7D7c367839AAf71A00a2C6A65',
  transaction: transaction,
  createdAt: day.add(Duration(hours: hour)),
);

P2pRequest tap(String id, int hour, P2pStatus status, {bool isReceiver = false, TxLink? transaction}) => P2pRequest(
  id: id,
  isReceiver: isReceiver,
  status: status,
  token: '0x5FbDB2315678afecb367f032d93F642f64180aa3',
  amount: usdc('5000000'),
  recipientName: 'Somchai Coffee',
  recipientVerified: false,
  recipientAddress: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8',
  expiresAt: day.add(Duration(hours: hour, minutes: 2)),
  createdAt: day.add(Duration(hours: hour)),
  senderAddress: '0x15d34AAf54267DB7D7c367839AAf71A00a2C6A65',
  transaction: transaction,
);

void main() {
  test('merges payments, deposits and tap payments, newest first', () {
    final cafe = payment('payment_1', 1);
    final added = deposit('deposit_1', 3, tx('55'));
    final paid = tap('request_1', 2, P2pStatus.completed, transaction: tx('66'));
    final sending = tap('request_2', 4, P2pStatus.submitted, transaction: tx('77'));

    expect(historyItems(payments: [cafe], deposits: [added], taps: [sending, paid]), [sending, added, paid, cafe]);
  });

  test('shows only tap payments that sent money', () {
    final taps = [
      for (final (i, status) in P2pStatus.values.indexed)
        tap('request_$i', i, status, transaction: status.isFinal ? tx('6$i') : null),
    ];
    final shown = historyItems(payments: [], deposits: [], taps: taps).cast<P2pRequest>().map((r) => r.status);
    expect(shown, unorderedEquals([P2pStatus.submitted, P2pStatus.completed]));
  });

  test("shows a received tap payment once, not again as the deposit of its transfer", () {
    final received = tap('request_1', 2, P2pStatus.completed, isReceiver: true, transaction: tx('ab'));
    final sameTransfer = deposit('deposit_2', 2, TxLink(hash: '0x${'AB' * 32}', url: ''));
    final other = deposit('deposit_3', 1, tx('cd'));

    expect(historyItems(payments: [], deposits: [sameTransfer, other], taps: [received]), [received, other]);
  });

  test("keeps a deposit whose tap payment isn't shown", () {
    final failed = tap('request_1', 2, P2pStatus.failed, transaction: tx('ab'));
    final arrived = deposit('deposit_2', 2, tx('ab'));

    expect(historyItems(payments: [], deposits: [arrived], taps: [failed]), [arrived]);
  });
}
