import 'package:flutter_test/flutter_test.dart';
import 'package:globalpay/core/config/app_config.dart';

const testKey = '0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a';

Matcher refusesUrl(String url) => throwsA(
  isA<ArgumentError>().having((e) => e.name, 'name', 'API_BASE_URL').having((e) => e.invalidValue, 'value', url),
);

void main() {
  group('debug builds', () {
    test('accept a plain-http API and keep the dev wallet key', () {
      final config = AppConfig.checked(
        apiBaseUrl: 'http://10.0.2.2:3000',
        chainId: 31337,
        devWalletPrivateKey: testKey,
        release: false,
      );
      expect(config.apiBaseUrl, 'http://10.0.2.2:3000');
      expect(config.chainId, 31337);
      expect(config.devWalletPrivateKey, testKey);
    });

    test('treat an empty key as none', () {
      final config = AppConfig.checked(
        apiBaseUrl: 'http://10.0.2.2:3000',
        chainId: 1,
        devWalletPrivateKey: '',
        release: false,
      );
      expect(config.devWalletPrivateKey, isNull);
    });

    test('use the emulator defaults when nothing is defined', () {
      final config = AppConfig.fromEnvironment(release: false);
      expect(config.apiBaseUrl, 'http://10.0.2.2:3000');
      expect(config.chainId, 84532);
      expect(config.devWalletPrivateKey, isNull);
    });
  });

  group('release builds', () {
    test('accept an https API', () {
      final config = AppConfig.checked(apiBaseUrl: 'https://api.globalpay.example', chainId: 84532, release: true);
      expect(config.apiBaseUrl, 'https://api.globalpay.example');
    });

    test('refuse a plain-http or malformed API URL', () {
      for (final url in [
        'http://10.0.2.2:3000',
        'HTTP://api.globalpay.example',
        'api.globalpay.example',
        'https://',
        '',
      ]) {
        expect(() => AppConfig.checked(apiBaseUrl: url, chainId: 84532, release: true), refusesUrl(url), reason: url);
      }
    });

    test("refuse the emulator's default plain-http URL", () {
      expect(() => AppConfig.fromEnvironment(release: true), refusesUrl('http://10.0.2.2:3000'));
    });

    test('ignore the dev wallet key', () {
      final config = AppConfig.checked(
        apiBaseUrl: 'https://api.globalpay.example',
        chainId: 84532,
        devWalletPrivateKey: testKey,
        release: true,
      );
      expect(config.devWalletPrivateKey, isNull);
    });
  });

  group('settlement rail', () {
    test('defaults to EVM, with no NEAR contracts and the default sign-in recipient', () {
      final config = AppConfig.fromEnvironment(release: false);
      expect(config.settlementRail, SettlementRail.evm);
      expect(config.isNear, isFalse);
      expect(config.nearUsdcContract, isNull);
      expect(config.nearSettlementContract, isNull);
      expect(config.nearSignInRecipient, 'globalpay.local');
      expect(const AppConfig(apiBaseUrl: 'http://x', chainId: 1).settlementRail, SettlementRail.evm);
    });

    test('reads the NEAR rail and its contracts; empty means unset', () {
      final config = AppConfig.checked(
        apiBaseUrl: 'http://10.0.2.2:3001',
        chainId: 84532,
        settlementRail: 'near',
        nearUsdcContract: 'usdc.globalpay.testnet',
        nearSettlementContract: 'settle.globalpay.testnet',
        nearSignInRecipient: 'globalpay.example',
        release: false,
      );
      expect(config.isNear, isTrue);
      expect(config.nearUsdcContract, 'usdc.globalpay.testnet');
      expect(config.nearSettlementContract, 'settle.globalpay.testnet');
      expect(config.nearSignInRecipient, 'globalpay.example');

      final empty = AppConfig.checked(
        apiBaseUrl: 'http://10.0.2.2:3001',
        chainId: 84532,
        settlementRail: '',
        nearUsdcContract: '',
        nearSettlementContract: '',
        nearSignInRecipient: '',
        release: false,
      );
      expect(empty.settlementRail, SettlementRail.evm);
      expect(empty.nearUsdcContract, isNull);
      expect(empty.nearSettlementContract, isNull);
      expect(empty.nearSignInRecipient, 'globalpay.local');
    });

    test('refuses an unknown rail', () {
      expect(
        () => AppConfig.checked(apiBaseUrl: 'http://x', chainId: 1, settlementRail: 'solana', release: false),
        throwsA(isA<ArgumentError>().having((e) => e.name, 'name', 'SETTLEMENT_RAIL')),
      );
    });
  });

  test('isHttps', () {
    expect(AppConfig.isHttps('https://api.globalpay.example/v1'), isTrue);
    expect(AppConfig.isHttps('HTTPS://api.globalpay.example'), isTrue);
    expect(AppConfig.isHttps('http://api.globalpay.example'), isFalse);
    expect(AppConfig.isHttps('wss://api.globalpay.example'), isFalse);
    expect(AppConfig.isHttps('/relative'), isFalse);
  });
}
