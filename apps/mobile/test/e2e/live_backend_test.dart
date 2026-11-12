@Tags(['e2e'])
library;

import 'package:flutter_test/flutter_test.dart';
import 'package:globalpay/core/config/app_config.dart';
import 'package:globalpay/core/storage/secure_store.dart';
import 'package:globalpay/data/api/api_client.dart';
import 'package:globalpay/data/repositories/account_repository.dart';
import 'package:globalpay/data/repositories/auth_repository.dart';
import 'package:globalpay/data/repositories/kyc_repository.dart';
import 'package:globalpay/data/repositories/payments_repository.dart';
import 'package:globalpay/data/session_store.dart';
import 'package:globalpay/domain/models/payment.dart';
import 'package:globalpay/services/wallet/dev_wallet_service.dart';

/// The app's data layer against a real backend on a local chain: sign-in, KYC, quote, signing,
/// payment and settlement. Skipped unless E2E_API_BASE_URL is set, e.g. with the backend running
/// against anvil (services/api/README.md, "Try a payment locally"):
///
///   flutter test test/e2e --dart-define=E2E_API_BASE_URL=http://127.0.0.1:3000
const apiBaseUrl = String.fromEnvironment('E2E_API_BASE_URL');

/// anvil account #4: funded with test USDC by contracts/script/DeployLocal.s.sol.
const anvil4 = '0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a';

/// A dynamic PromptPay QR for 120.00 THB.
const qr120 =
    '00020101021230510016A00000067701011201150999999999999010208E2ETEST153037645406120.005802TH'
    '5919GLOBALPAY TEST CAFE6007BANGKOK6304';

void main() {
  test(
    'pays a PromptPay QR end to end and sees it settle',
    () async {
      const config = AppConfig(apiBaseUrl: apiBaseUrl, chainId: 31337);
      final storage = MemorySecureStore();
      final sessions = SessionStore(storage);
      final wallet = DevWalletService(store: storage, importKey: anvil4);
      final api = ApiClient(config, token: () => sessions.current?.token);
      final auth = AuthRepository(api: api, wallet: wallet, sessions: sessions);
      final kyc = KycRepository(api: api);
      final payments = PaymentsRepository(api: api);
      final account = AccountRepository(api: api);

      final session = await auth.signIn();
      expect(session.walletAddress, '0x15d34AAf54267DB7D7c367839AAf71A00a2C6A65');
      await kyc.start();
      expect((await kyc.status()).canPay, isTrue);

      final before = (await account.balance()).amount.units;
      final quote = await payments.requestQuote(payer: session.walletAddress, qrPayload: withCrc(qr120));
      expect(quote.fiatAmount.minor, BigInt.from(12000));

      final signature = await wallet.signTypedData(quote.authorization.typedData);
      var payment = await payments.submit(quote, signature);
      expect(payment.status, PaymentStatus.submitted);

      final deadline = DateTime.now().add(const Duration(seconds: 60));
      while (!payment.status.isTerminal && DateTime.now().isBefore(deadline)) {
        await Future<void>.delayed(const Duration(milliseconds: 500));
        payment = await payments.get(payment.id);
      }
      expect(payment.status, PaymentStatus.settled, reason: payment.failureReason);
      expect(payment.settleTx, isNotNull);
      expect((await account.balance()).amount.units, before - quote.tokenAmount.units);
      expect((await account.history()).first.id, payment.id);
    },
    skip: apiBaseUrl.isEmpty ? 'Set E2E_API_BASE_URL to run against a live backend' : false,
  );
}

/// Appends the CRC to a payload ending in "6304".
String withCrc(String body) {
  var crc = 0xFFFF;
  for (final byte in body.codeUnits) {
    crc ^= byte << 8;
    for (var bit = 0; bit < 8; bit++) {
      crc = (crc & 0x8000) != 0 ? ((crc << 1) ^ 0x1021) & 0xFFFF : (crc << 1) & 0xFFFF;
    }
  }
  return body + crc.toRadixString(16).toUpperCase().padLeft(4, '0');
}
