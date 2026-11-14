import 'dart:convert';

import 'package:blockchain_utils/blockchain_utils.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:globalpay/core/errors/app_exception.dart';
import 'package:globalpay/core/storage/secure_store.dart';
import 'package:globalpay/domain/models/quote.dart';
import 'package:globalpay/services/wallet/near/borsh.dart';
import 'package:globalpay/services/wallet/near/delegate_action.dart';
import 'package:globalpay/services/wallet/near/near_keys.dart';
import 'package:globalpay/services/wallet/near/near_wallet_service.dart';

import '../support/fake_fingerprint.dart';
import '../support/near_vectors.dart';

String hex(List<int> bytes) => BytesUtils.toHexString(bytes);

final nep413 = nearVectors['nep413'] as Map<String, dynamic>;
final delegate = nearVectors['delegate'] as Map<String, dynamic>;
final payment = nearPaymentFromJson(delegate['nearPayment'] as Map<String, dynamic>);

NearPayment withPayment({String? signerId, String? publicKey, String? gas}) => NearPayment(
  signerId: signerId ?? payment.signerId,
  publicKey: publicKey ?? payment.publicKey,
  receiverId: payment.receiverId,
  methodName: payment.methodName,
  args: payment.args,
  gas: gas ?? payment.gas,
  deposit: payment.deposit,
  nonce: payment.nonce,
  maxBlockHeight: payment.maxBlockHeight,
);

void main() {
  group('borsh', () {
    test('writes little-endian integers, strings, byte vectors and options', () {
      final bytes =
          (BorshWriter()
                ..u8(7)
                ..u32(0x01020304)
                ..u64(BigInt.parse('0102030405060708', radix: 16))
                ..u128(BigInt.one)
                ..string('฿1')
                ..bytes([0xaa, 0xbb])
                ..fixedBytes([0xcc])
                ..optionalString(null)
                ..optionalString('x'))
              .toBytes();
      expect(
        hex(bytes),
        '07'
        '04030201'
        '0807060504030201'
        '01000000000000000000000000000000'
        '04000000e0b8bf31'
        '02000000aabb'
        'cc'
        '00'
        '010100000078',
      );
    });

    test('refuses values out of range', () {
      expect(() => BorshWriter().u8(256), throwsArgumentError);
      expect(() => BorshWriter().u32(-1), throwsArgumentError);
      expect(() => BorshWriter().u64(BigInt.one << 64), throwsArgumentError);
      expect(() => BorshWriter().u128(BigInt.from(-1)), throwsArgumentError);
      expect(() => BorshWriter().fixedBytes([300]), throwsArgumentError);
    });
  });

  group('matches near-api-js', () {
    test('the key: implicit account id and ed25519 public key', () async {
      final wallet = NearWalletService(store: MemorySecureStore(), importSeed: nearTestSeed);
      expect(await wallet.connect(), nearTestAccount);
      expect(wallet.accountId, nearTestAccount);
      expect(wallet.publicKey, nearTestPublicKey);
      expect(implicitAccountId(parseNearPublicKey(nearTestPublicKey)), nearTestAccount);
      expect(nearPublicKeyString(BytesUtils.fromHexString(nearTestAccount)), nearTestPublicKey);
    });

    test('the NEP-413 digest and signature', () async {
      final nonce = BytesUtils.fromHexString(nep413['nonce'] as String);
      final digest = nep413Digest(
        message: nep413['message'] as String,
        nonce: nonce,
        recipient: nep413['recipient'] as String,
      );
      expect(hex(digest), nep413['digest']);

      final wallet = NearWalletService(store: MemorySecureStore(), importSeed: nearTestSeed);
      await wallet.connect();
      expect(
        await wallet.signNep413(nep413['message'] as String, nonce, nep413['recipient'] as String),
        nep413['signature'],
      );
    });

    test('the delegate action: borsh bytes, args JSON, digest, signature and SignedDelegate', () async {
      final action = DelegateAction.fromPayment(payment);
      expect(utf8.decode(action.actions.single.args), delegate['argsJson']);
      expect(hex(action.serialize()), delegate['borsh']);
      expect(hex(action.digest()), delegate['digest']);
      final signature = base64.decode(delegate['signature'] as String);
      expect(base64.encode(action.signedBytes(signature)), delegate['signedDelegate']);

      final wallet = NearWalletService(store: MemorySecureStore(), importSeed: nearTestSeed);
      await wallet.connect();
      expect(await wallet.signDelegate(payment), delegate['signedDelegate']);
    });
  });

  group('the wallet', () {
    test('creates a random key on first connect and keeps it, also after disconnecting', () async {
      final store = MemorySecureStore();
      final wallet = NearWalletService(store: store);
      final account = await wallet.connect();
      expect(account, matches(RegExp(r'^[0-9a-f]{64}$')));
      expect(wallet.publicKey, startsWith('ed25519:'));
      expect(store.values[NearWalletService.storageKey], matches(RegExp(r'^[0-9a-f]{64}$')));

      await wallet.disconnect();
      expect(wallet.accountId, isNull);
      expect(wallet.publicKey, isNull);
      expect(() => wallet.signNep413('hi', List.filled(32, 0), 'globalpay.local'), throwsA(isA<AppException>()));
      expect(await NearWalletService(store: store).connect(), account);
    });

    test('signs only for its own account and key, and only what it can encode', () async {
      final wallet = NearWalletService(store: MemorySecureStore(), importSeed: nearTestSeed);
      expect(() => wallet.signDelegate(payment), throwsA(isA<AppException>()));
      await wallet.connect();

      final other = NearWalletService(store: MemorySecureStore());
      final otherAccount = await other.connect();
      for (final (wrong, code) in [
        (withPayment(signerId: otherAccount), 'wallet_mismatch'),
        (withPayment(publicKey: other.publicKey), 'wallet_mismatch'),
        (withPayment(publicKey: 'ed25519:notbase58!'), 'invalid_payment'),
        (withPayment(gas: '-1'), 'invalid_payment'),
      ]) {
        await expectLater(
          wallet.signDelegate(wrong),
          throwsA(isA<AppException>().having((e) => e.code, 'code', code)),
          reason: code,
        );
      }
    });

    group('with the fingerprint vault', () {
      test('keeps the key only sealed, and asks for the fingerprint for every signature', () async {
        final store = MemorySecureStore();
        final vault = FakeVault();
        final wallet = NearWalletService(store: store, vault: vault, importSeed: nearTestSeed);
        expect(await wallet.connect(), nearTestAccount);
        expect(store.values.containsKey(NearWalletService.storageKey), isFalse);
        expect(store.values[NearWalletService.sealedKey], isNot(nearTestSeed));
        expect(store.values[NearWalletService.publicKeyKey], nearTestPublicKey);

        expect(await wallet.signDelegate(payment), delegate['signedDelegate']);
        final nonce = BytesUtils.fromHexString(nep413['nonce'] as String);
        expect(
          await wallet.signNep413(nep413['message'] as String, nonce, nep413['recipient'] as String),
          nep413['signature'],
        );
        expect(vault.prompts, [
          'Protect your wallet with your fingerprint',
          'Approve this payment',
          'Sign in to GlobalPay',
        ]);
      });

      test('reconnects from the stored public key without a prompt, and moves a plain key into the vault', () async {
        final store = MemorySecureStore();
        final account = await NearWalletService(store: store).connect();
        final vault = FakeVault();
        expect(await NearWalletService(store: store, vault: vault).connect(), account);
        expect(store.values.containsKey(NearWalletService.storageKey), isFalse);
        vault.prompts.clear();
        expect(await NearWalletService(store: store, vault: vault).connect(), account);
        expect(vault.prompts, isEmpty);
      });

      test('passes on a cancelled prompt and signs nothing', () async {
        final vault = FakeVault();
        final wallet = NearWalletService(store: MemorySecureStore(), vault: vault, importSeed: nearTestSeed);
        await wallet.connect();
        vault.cancelNext = true;
        await expectLater(
          wallet.signDelegate(payment),
          throwsA(isA<AppException>().having((e) => e.code, 'code', 'biometric_cancelled')),
        );
      });

      test('release builds refuse to keep the key outside the vault', () async {
        final store = MemorySecureStore();
        await expectLater(
          NearWalletService(store: store, vault: FakeVault(available: false), requireVault: true).connect(),
          throwsA(isA<AppException>().having((e) => e.code, 'code', 'biometric_unavailable')),
        );
        expect(store.values, isEmpty);
        expect(await NearWalletService(store: store, vault: FakeVault(), requireVault: true).connect(), isNotEmpty);
      });
    });
  });
}
