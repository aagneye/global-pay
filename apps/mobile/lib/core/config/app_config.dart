/// App settings from `--dart-define`, so the app ships no secrets.
///
/// Example: flutter run --dart-define=API_BASE_URL=http://10.0.2.2:3000
class AppConfig {
  const AppConfig({required this.apiBaseUrl, required this.chainId, this.devWalletPrivateKey});

  factory AppConfig.fromEnvironment() => const AppConfig(
    // 10.0.2.2 is the host machine as seen from the Android emulator.
    apiBaseUrl: String.fromEnvironment('API_BASE_URL', defaultValue: 'http://10.0.2.2:3000'),
    // Base Sepolia
    chainId: int.fromEnvironment('CHAIN_ID', defaultValue: 84532),
    // Optional, local chains only: a funded test key for the dev wallet's first start,
    // e.g. anvil account #4. Never a real key: dart-defines end up in the app binary.
    devWalletPrivateKey: String.fromEnvironment('DEV_WALLET_PRIVATE_KEY'),
  );

  final String apiBaseUrl;
  final int chainId;
  final String? devWalletPrivateKey;
}
