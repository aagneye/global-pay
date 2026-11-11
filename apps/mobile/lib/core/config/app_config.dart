/// App settings from `--dart-define`, so the app ships no secrets.
///
/// Example: flutter run --dart-define=API_BASE_URL=http://10.0.2.2:3000
class AppConfig {
  const AppConfig({required this.apiBaseUrl, required this.chainId, required this.explorerUrl});

  factory AppConfig.fromEnvironment() => const AppConfig(
        // 10.0.2.2 is the host machine as seen from the Android emulator.
        apiBaseUrl: String.fromEnvironment('API_BASE_URL', defaultValue: 'http://10.0.2.2:3000'),
        // Base Sepolia
        chainId: int.fromEnvironment('CHAIN_ID', defaultValue: 84532),
        explorerUrl: String.fromEnvironment(
          'EXPLORER_URL',
          defaultValue: 'https://sepolia.basescan.org',
        ),
      );

  final String apiBaseUrl;
  final int chainId;
  final String explorerUrl;

  Uri transactionUrl(String txHash) => Uri.parse('$explorerUrl/tx/$txHash');
}
