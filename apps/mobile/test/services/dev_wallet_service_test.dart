import 'package:flutter_test/flutter_test.dart';
import 'package:globalpay/core/errors/app_exception.dart';
import 'package:globalpay/core/storage/secure_store.dart';
import 'package:globalpay/services/wallet/dev_wallet_service.dart';

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
}
