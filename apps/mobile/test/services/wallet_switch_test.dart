import 'package:flutter_test/flutter_test.dart';
import 'package:globalpay/core/errors/app_exception.dart';
import 'package:globalpay/core/storage/secure_store.dart';
import 'package:globalpay/services/wallet/dev_wallet_service.dart';
import 'package:globalpay/services/wallet/privy_wallet_service.dart';
import 'package:globalpay/services/wallet/wallet_switch.dart';

import '../support/fake_fingerprint.dart';
import '../support/fake_privy.dart';

const anvil4 = '0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a';
const devAddress = '0x15d34AAf54267DB7D7c367839AAf71A00a2C6A65';
const embeddedAddress = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8';

Matcher throwsAppException(String code) => throwsA(isA<AppException>().having((error) => error.code, 'code', code));

void main() {
  late MemorySecureStore store;
  late FakePrivyClient privy;

  setUp(() {
    store = MemorySecureStore();
    privy = FakePrivyClient(authenticated: true, hasWallet: true);
  });

  WalletSwitch build({bool embedded = true, bool dev = true}) => WalletSwitch(
    store: store,
    embedded: embedded ? PrivyWalletService(privy, gate: FakeGate()) : null,
    dev: dev ? DevWalletService(store: store, importKey: anvil4) : null,
  );

  test('offers the embedded wallet first, and the dev wallet only when given one', () {
    expect(build().available, [WalletKind.embedded, WalletKind.dev]);
    expect(build(dev: false).available, [WalletKind.embedded]);
    expect(build(embedded: false).available, [WalletKind.dev]);
    expect(build(embedded: false, dev: false).available, isEmpty);
  });

  test('uses the chosen wallet and reconnects it after a restart', () async {
    final wallets = build();
    await wallets.use(WalletKind.dev);
    expect(await wallets.connect(), devAddress);
    expect(await wallets.currentAddress(), devAddress);
    expect(await wallets.signMessage('hi'), matches(RegExp(r'^0x[0-9a-f]{130}$')));

    expect(await build().connect(), devAddress);

    await wallets.use(WalletKind.embedded);
    expect(await wallets.connect(), embeddedAddress);
    expect(await build().connect(), embeddedAddress);
  });

  test('without a saved choice, or one this build lacks, connects the first wallet offered', () async {
    expect(await build().connect(), embeddedAddress);

    await build().use(WalletKind.dev);
    expect(await build(dev: false).connect(), embeddedAddress);
  });

  test('says sign-in is not set up when the build has no wallet', () async {
    final none = build(embedded: false, dev: false);
    await expectLater(none.connect(), throwsAppException('wallet_not_configured'));
    await expectLater(none.use(WalletKind.dev), throwsAppException('wallet_not_configured'));
    await expectLater(build(embedded: false).use(WalletKind.embedded), throwsAppException('wallet_not_configured'));
  });

  test('signs only after connecting', () async {
    final wallets = build();
    await expectLater(wallets.signMessage('hi'), throwsAppException('wallet_not_connected'));
    await expectLater(wallets.signTypedData(const {}), throwsAppException('wallet_not_connected'));
    expect(await wallets.currentAddress(), isNull);
  });

  test('disconnecting signs the wallet out and forgets the choice', () async {
    final wallets = build();
    await wallets.use(WalletKind.embedded);
    await wallets.connect();

    await wallets.disconnect();
    expect(privy.authenticated, isFalse);
    expect(store.values.containsKey(WalletSwitch.kindKey), isFalse);
    expect(await wallets.currentAddress(), isNull);
    await expectLater(wallets.signMessage('hi'), throwsAppException('wallet_not_connected'));
  });
}
