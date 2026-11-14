import 'package:flutter_test/flutter_test.dart';
import 'package:globalpay/core/errors/app_exception.dart';
import 'package:globalpay/core/storage/secure_store.dart';
import 'package:globalpay/services/tap/tap_services.dart';
import 'package:globalpay/services/wallet/signature_gate.dart';

import '../support/fake_fingerprint.dart';

Matcher throwsAppException(String code) => throwsA(isA<AppException>().having((error) => error.code, 'code', code));

void main() {
  late MemorySecureStore store;
  late FakeVault vault;

  setUp(() {
    store = MemorySecureStore();
    vault = FakeVault();
  });

  FingerprintGate gate({bool requireBiometrics = true, KeyVault? withVault}) =>
      FingerprintGate(vault: withVault ?? vault, store: store, requireBiometrics: requireBiometrics);

  test('the first check seals a random token; each later check must open it', () async {
    await gate().confirm('Sign in to GlobalPay');
    await gate().confirm('Approve this payment');
    await gate().confirm('Approve this payment');

    expect(vault.prompts, ['Sign in to GlobalPay', 'Approve this payment', 'Approve this payment']);
    final token = vault.secrets.single;
    expect(token, matches(RegExp(r'^[0-9a-f]{64}$')));
    // Only the sealed token and its digest are stored, never the token itself.
    expect(store.values.keys, unorderedEquals([FingerprintGate.sealedKey, FingerprintGate.digestKey]));
    expect(store.values.values, isNot(contains(token)));
  });

  test('each phone gets its own token', () async {
    await gate().confirm('a');
    final other = FakeVault();
    await FingerprintGate(vault: other, store: MemorySecureStore(), requireBiometrics: true).confirm('a');
    expect(other.secrets.single, isNot(vault.secrets.single));
  });

  test('a cancelled prompt fails this check only', () async {
    vault.cancelNext = true;
    await expectLater(gate().confirm('Sign in to GlobalPay'), throwsAppException('biometric_cancelled'));
    expect(store.values, isEmpty);

    await gate().confirm('Sign in to GlobalPay');
    vault.cancelNext = true;
    await expectLater(gate().confirm('Approve this payment'), throwsAppException('biometric_cancelled'));
    await gate().confirm('Approve this payment');
  });

  test('changed fingerprints lock it until a fresh email sign-in', () async {
    await gate().confirm('Sign in to GlobalPay');
    vault.invalidated = true;

    await expectLater(gate().confirm('Approve this payment'), throwsAppException('biometric_reset'));
    vault.prompts.clear();
    // Still locked, even once the vault could seal again: a new fingerprint must not be enough.
    vault.invalidated = false;
    await expectLater(gate().confirm('Approve this payment'), throwsAppException('biometric_reset'));
    expect(vault.prompts, isEmpty);
    expect(store.values.keys, [FingerprintGate.lockedKey]);

    await gate().startOver();
    await gate().confirm('Sign in to GlobalPay');
    expect(vault.secrets, hasLength(2));
    await gate().confirm('Approve this payment');
  });

  test('a token that no longer matches its digest locks it too', () async {
    await gate().confirm('Sign in to GlobalPay');
    store.values[FingerprintGate.sealedKey] = 'forged';

    await expectLater(gate().confirm('Approve this payment'), throwsAppException('biometric_reset'));
    await expectLater(gate().confirm('Approve this payment'), throwsAppException('biometric_reset'));
  });

  test('a fresh sign-in also starts over without a lock', () async {
    await gate().confirm('Sign in to GlobalPay');
    await gate().startOver();
    expect(store.values, isEmpty);
    await gate().confirm('Sign in to GlobalPay');
    expect(vault.secrets, hasLength(2));
  });

  test('without a strong fingerprint, release builds refuse and debug builds skip the check', () async {
    vault.available = false;
    await expectLater(gate().confirm('Approve this payment'), throwsAppException('biometric_unavailable'));
    expect(FingerprintGate.unavailable.message, contains('Set up a fingerprint'));

    final noVault = FingerprintGate(vault: null, store: store, requireBiometrics: true);
    await expectLater(noVault.confirm('Approve this payment'), throwsAppException('biometric_unavailable'));

    await gate(requireBiometrics: false).confirm('Approve this payment');
    await FingerprintGate(vault: null, store: store, requireBiometrics: false).confirm('Approve this payment');
    expect(vault.prompts, isEmpty);
  });

  test('a lock holds even in a debug build without a fingerprint', () async {
    await gate().confirm('Sign in to GlobalPay');
    vault.invalidated = true;
    await expectLater(gate().confirm('Approve this payment'), throwsAppException('biometric_reset'));

    vault.available = false;
    await expectLater(
      gate(requireBiometrics: false).confirm('Approve this payment'),
      throwsAppException('biometric_reset'),
    );
  });
}
