import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:globalpay/core/errors/app_exception.dart';
import 'package:globalpay/services/wallet/privy_client.dart';
import 'package:globalpay/services/wallet/privy_sdk_client.dart';
import 'package:globalpay/services/wallet/privy_wallet_service.dart';
import 'package:privy_flutter/privy_flutter.dart';

import '../support/fake_fingerprint.dart';
import '../support/fake_privy.dart';

const email = 'somchai@example.com';
const wallet = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8';

Matcher throwsAppException(String code) => throwsA(isA<AppException>().having((error) => error.code, 'code', code));

/// A Privy user who is signed in and already has a wallet. Every fingerprint check passes unless [gate]
/// says otherwise.
(PrivyWalletService, FakePrivyClient) connected({FakeGate? gate}) {
  final client = FakePrivyClient(authenticated: true, hasWallet: true);
  return (PrivyWalletService(client, gate: gate ?? FakeGate()), client);
}

void main() {
  test('signs in with an email code and creates the wallet on first connect', () async {
    final client = FakePrivyClient();
    final service = PrivyWalletService(client, gate: FakeGate());

    await service.sendEmailCode(' $email ');
    expect(client.codesSentTo, [email]);
    await service.verifyEmailCode(email: email, code: ' 123456 ');

    expect(await service.connect(), wallet);
    expect(await service.currentAddress(), wallet);
    expect(client.walletsCreated, 1);

    // Connecting again reuses the wallet.
    expect(await service.connect(), wallet);
    expect(client.walletsCreated, 1);
  });

  test('checks the email and the code before asking Privy', () async {
    final client = FakePrivyClient();
    final service = PrivyWalletService(client, gate: FakeGate());

    for (final bad in ['', 'somchai', 'somchai@', 'a b@example.com']) {
      await expectLater(service.sendEmailCode(bad), throwsAppException('email_invalid'), reason: bad);
    }
    await expectLater(service.verifyEmailCode(email: email, code: '  '), throwsAppException('email_code_invalid'));
    expect(client.calls, isEmpty);
  });

  test('a wrong code fails with email_code_invalid and leaves the user signed out', () async {
    final client = FakePrivyClient();
    final service = PrivyWalletService(client, gate: FakeGate());

    await service.sendEmailCode(email);
    await expectLater(service.verifyEmailCode(email: email, code: '000000'), throwsAppException('email_code_invalid'));
    await expectLater(service.connect(), throwsAppException('wallet_not_connected'));
    expect(await service.currentAddress(), isNull);
  });

  test('a failed send fails with email_code_not_sent', () async {
    final client = FakePrivyClient()..failures['sendEmailCode'] = PrivyFailure.sendCode;
    await expectLater(
      PrivyWalletService(client, gate: FakeGate()).sendEmailCode(email),
      throwsAppException('email_code_not_sent'),
    );
  });

  test('sending a code signs out an earlier Privy user first', () async {
    final (service, client) = connected();
    await service.connect();

    await service.sendEmailCode('other@example.com');
    expect(client.calls, containsAllInOrder(['logout', 'sendEmailCode']));
    expect(await service.currentAddress(), isNull);
  });

  test('reconnects a saved Privy session without a code', () async {
    final (service, client) = connected();
    expect(await service.connect(), wallet);
    expect(client.codesSentTo, isEmpty);
    expect(client.walletsCreated, 0);
  });

  test('passes personal_sign through for the connected wallet', () async {
    final (service, client) = connected();
    await service.connect();

    const message = 'globalpay.local wants you to sign in with your Ethereum account:\n$wallet';
    expect(await service.signMessage(message), client.signature);
    expect(client.signed, [('personal_sign', wallet, message)]);
  });

  test('passes typed data through as eth_signTypedData_v4 JSON', () async {
    final (service, client) = connected();
    await service.connect();

    final typedData = <String, Object?>{
      'types': {
        'EIP712Domain': [
          {'name': 'name', 'type': 'string'},
          {'name': 'chainId', 'type': 'uint256'},
        ],
        'ReceiveWithAuthorization': [
          {'name': 'value', 'type': 'uint256'},
        ],
      },
      'primaryType': 'ReceiveWithAuthorization',
      'domain': {'name': 'USDC', 'chainId': 84532},
      'message': {'value': '7477454'},
    };
    expect(await service.signTypedData(typedData), client.signature);

    final (method, address, json) = client.signed.single;
    expect(method, 'eth_signTypedData_v4');
    expect(address, wallet);
    expect(jsonDecode(json), typedData);
  });

  test('adds a missing 0x and rejects anything that is not a 65-byte signature', () async {
    final (service, client) = connected();
    await service.connect();

    client.signature = 'cd' * 65;
    expect(await service.signMessage('hi'), '0x${'cd' * 65}');

    for (final bad in ['', '0x', '0x${'cd' * 64}', 'not a signature']) {
      client.signature = bad;
      await expectLater(service.signMessage('hi'), throwsAppException('signature_failed'), reason: bad);
    }
  });

  test('refuses to sign before connecting, without asking for the fingerprint', () async {
    final client = FakePrivyClient(authenticated: true, hasWallet: true);
    final gate = FakeGate();
    final service = PrivyWalletService(client, gate: gate);

    await expectLater(service.signMessage('hi'), throwsAppException('wallet_not_connected'));
    await expectLater(service.signTypedData(const {}), throwsAppException('wallet_not_connected'));
    expect(client.signed, isEmpty);
    expect(gate.reasons, isEmpty);
  });

  test('asks for the fingerprint before every signature', () async {
    final gate = FakeGate();
    final (service, client) = connected(gate: gate);
    await service.connect();

    await service.signMessage('hi');
    await service.signTypedData(const {'primaryType': 'TransferWithAuthorization'});
    await service.signTypedData(const {'primaryType': 'TransferWithAuthorization'});
    expect(gate.reasons, ['Sign in to GlobalPay', 'Approve this payment', 'Approve this payment']);
    expect(client.signed, hasLength(3));
  });

  test('never asks Privy to sign when the fingerprint check fails', () async {
    final gate = FakeGate();
    final (service, client) = connected(gate: gate);
    await service.connect();

    for (final code in ['biometric_cancelled', 'biometric_failed', 'biometric_unavailable', 'biometric_reset']) {
      gate.failNext = AppException(code, 'no');
      await expectLater(service.signTypedData(const {}), throwsAppException(code), reason: code);
      gate.failNext = AppException(code, 'no');
      await expectLater(service.signMessage('hi'), throwsAppException(code), reason: code);
    }
    expect(client.signed, isEmpty);
  });

  test('starts the fingerprint check over after a fresh email sign-in, not after a wrong code', () async {
    final client = FakePrivyClient();
    final gate = FakeGate();
    final service = PrivyWalletService(client, gate: gate);

    await service.sendEmailCode(email);
    await expectLater(service.verifyEmailCode(email: email, code: '000000'), throwsAppException('email_code_invalid'));
    expect(gate.startOvers, 0);

    await service.verifyEmailCode(email: email, code: '123456');
    expect(gate.startOvers, 1);

    // Reconnecting a saved session doesn't.
    await service.connect();
    expect(gate.startOvers, 1);
  });

  test('maps every Privy failure to an AppException code', () async {
    const codes = {
      PrivyFailure.notAuthenticated: 'wallet_not_connected',
      PrivyFailure.sendCode: 'email_code_not_sent',
      PrivyFailure.invalidCode: 'email_code_invalid',
      PrivyFailure.wallet: 'wallet_unavailable',
      PrivyFailure.signing: 'signature_failed',
      PrivyFailure.timeout: 'wallet_timeout',
      PrivyFailure.offline: 'wallet_offline',
      PrivyFailure.unknown: 'wallet_error',
    };
    expect(codes.keys, containsAll(PrivyFailure.values));

    final (service, client) = connected();
    await service.connect();
    for (final MapEntry(key: failure, value: code) in codes.entries) {
      client.failures['signTypedDataV4'] = failure;
      await expectLater(service.signTypedData(const {}), throwsAppException(code), reason: failure.name);
      expect(PrivyWalletService.appExceptionFor(failure).message, isNotEmpty);
    }

    client.failures['ethereumWallet'] = PrivyFailure.wallet;
    await expectLater(service.connect(), throwsAppException('wallet_unavailable'));
    client.failures['isAuthenticated'] = PrivyFailure.offline;
    await expectLater(service.connect(), throwsAppException('wallet_offline'));
  });

  test('signs out of Privy on disconnect, even if Privy fails to answer', () async {
    final (service, client) = connected();
    await service.connect();

    await service.disconnect();
    expect(client.authenticated, isFalse);
    expect(await service.currentAddress(), isNull);
    await expectLater(service.signMessage('hi'), throwsAppException('wallet_not_connected'));

    client.failures['logout'] = PrivyFailure.unknown;
    await service.disconnect();
  });

  test('sorts Privy SDK errors into failures', () {
    expect(classifyPrivyError(const PrivyTimeoutException('awaitReady'), PrivyFailure.unknown), PrivyFailure.timeout);
    expect(classifyPrivyError(const MfaSdkTimeoutException(), PrivyFailure.signing), PrivyFailure.timeout);
    expect(
      classifyPrivyError(const PrivyAuthException('no user', flow: 'unknown', stage: 'userAuth'), PrivyFailure.signing),
      PrivyFailure.notAuthenticated,
    );
    expect(
      classifyPrivyError(const PrivyWalletException('failed', operation: 'create'), PrivyFailure.unknown),
      PrivyFailure.wallet,
    );
    expect(
      classifyPrivyError(const PrivyWalletException('rejected', operation: 'rpcRequest'), PrivyFailure.signing),
      PrivyFailure.signing,
    );
    expect(
      classifyPrivyError(
        const PrivyAuthException('bad', flow: 'email', stage: 'loginWithCode'),
        PrivyFailure.invalidCode,
      ),
      PrivyFailure.invalidCode,
    );
    expect(classifyPrivyError(const PrivyException('?'), PrivyFailure.sendCode), PrivyFailure.sendCode);
  });

  test('reads the Privy IDs from dart-defines (none in tests)', () {
    expect(PrivySettings.fromEnvironment().isConfigured, isFalse);
    expect(const PrivySettings(appId: 'app', clientId: '').isConfigured, isFalse);
    expect(const PrivySettings(appId: 'app', clientId: 'client').isConfigured, isTrue);
  });
}
