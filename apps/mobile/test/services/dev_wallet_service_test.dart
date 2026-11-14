import 'package:flutter_test/flutter_test.dart';
import 'package:globalpay/core/errors/app_exception.dart';
import 'package:globalpay/core/storage/secure_store.dart';
import 'package:globalpay/services/tap/tap_services.dart';
import 'package:globalpay/services/wallet/dev_wallet_service.dart';

/// A vault that "encrypts" by reversing, and counts fingerprint prompts.
class FakeVault implements KeyVault {
  FakeVault({this.available = true});

  final bool available;
  final prompts = <String>[];
  bool cancelNext = false;

  @override
  Future<bool> isAvailable() async => available;

  @override
  Future<String> seal(String secret, {required String reason}) async {
    prompts.add(reason);
    return secret.split('').reversed.join();
  }

  @override
  Future<String> open(String sealed, {required String reason}) async {
    prompts.add(reason);
    if (cancelNext) {
      cancelNext = false;
      throw const AppException('biometric_cancelled', 'Cancelled');
    }
    return sealed.split('').reversed.join();
  }
}

const anvil4 = '0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a';

void main() {
  test('creates a key on first connect and keeps it', () async {
    final store = MemorySecureStore();
    final first = await DevWalletService(store: store).connect();
    final again = await DevWalletService(store: store).connect();

    expect(first, matches(RegExp(r'^0x[0-9a-fA-F]{40}$')));
    expect(again, first);
    expect(store.values[DevWalletService.storageKey], matches(RegExp(r'^0x[0-9a-f]{64}$')));
  });

  test('imports the configured key only when there is none yet', () async {
    final store = MemorySecureStore();
    expect(
      await DevWalletService(store: store, importKey: anvil4).connect(),
      '0x15d34AAf54267DB7D7c367839AAf71A00a2C6A65',
    );

    final existing = MemorySecureStore();
    final address = await DevWalletService(store: existing).connect();
    expect(await DevWalletService(store: existing, importKey: anvil4).connect(), address);
  });

  test('signs only while connected, and keeps the key after disconnecting', () async {
    final store = MemorySecureStore();
    final wallet = DevWalletService(store: store, importKey: anvil4);

    expect(() => wallet.signMessage('hi'), throwsA(isA<AppException>()));
    await wallet.connect();
    expect(await wallet.currentAddress(), '0x15d34AAf54267DB7D7c367839AAf71A00a2C6A65');
    expect(await wallet.signMessage('hi'), matches(RegExp(r'^0x[0-9a-f]{130}$')));

    await wallet.disconnect();
    expect(await wallet.currentAddress(), isNull);
    expect(store.values[DevWalletService.storageKey], anvil4);
  });

  group('with the fingerprint vault', () {
    test('keeps the key only sealed, and asks for the fingerprint for every signature', () async {
      final store = MemorySecureStore();
      final vault = FakeVault();
      final wallet = DevWalletService(store: store, importKey: anvil4, vault: vault);
      expect(await wallet.connect(), '0x15d34AAf54267DB7D7c367839AAf71A00a2C6A65');
      expect(store.values.containsKey(DevWalletService.storageKey), isFalse);
      expect(store.values[DevWalletService.sealedKey], isNot(contains(anvil4.substring(2))));

      final plain = DevWalletService(store: MemorySecureStore(), importKey: anvil4);
      await plain.connect();
      expect(await wallet.signMessage('hello'), await plain.signMessage('hello'));
      await wallet.signMessage('again');
      expect(vault.prompts, ['Protect your wallet with your fingerprint', 'Sign in to GlobalPay', 'Sign in to GlobalPay']);
    });

    test('reconnects from the stored address without a prompt', () async {
      final store = MemorySecureStore();
      final vault = FakeVault();
      final address = await DevWalletService(store: store, vault: vault).connect();
      vault.prompts.clear();
      expect(await DevWalletService(store: store, vault: vault).connect(), address);
      expect(vault.prompts, isEmpty);
    });

    test('moves a key stored the old way into the vault', () async {
      final store = MemorySecureStore();
      final address = await DevWalletService(store: store).connect();
      expect(await DevWalletService(store: store, vault: FakeVault()).connect(), address);
      expect(store.values.containsKey(DevWalletService.storageKey), isFalse);
      expect(store.values[DevWalletService.addressKey], address);
    });

    test('passes on a cancelled fingerprint prompt, and falls back when no biometrics are enrolled', () async {
      final vault = FakeVault();
      final wallet = DevWalletService(store: MemorySecureStore(), vault: vault);
      await wallet.connect();
      vault.cancelNext = true;
      expect(() => wallet.signMessage('x'), throwsA(isA<AppException>().having((e) => e.code, 'code', 'biometric_cancelled')));

      final store = MemorySecureStore();
      await DevWalletService(store: store, vault: FakeVault(available: false)).connect();
      expect(store.values.containsKey(DevWalletService.storageKey), isTrue);
    });
  });
}
