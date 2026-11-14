import 'package:flutter/foundation.dart';

/// App settings from `--dart-define`, so the app ships no secrets.
///
/// Example: flutter run --dart-define=API_BASE_URL=http://10.0.2.2:3000
///
/// Release builds are stricter:
/// - `API_BASE_URL` must be https, or the app stops at startup. Android's cleartext setting doesn't
///   cover Dart's own HTTP client (Dio), so this check is what keeps plain HTTP out of a release.
/// - `DEV_WALLET_PRIVATE_KEY` is ignored, and not even compiled in, so a test key can't ship.
class AppConfig {
  const AppConfig({required this.apiBaseUrl, required this.chainId, this.devWalletPrivateKey});

  /// This build's settings. [release] is [kReleaseMode]; tests set it to check the release rules.
  factory AppConfig.fromEnvironment({bool release = kReleaseMode}) => AppConfig.checked(
    // 10.0.2.2 is the host machine as seen from the Android emulator.
    apiBaseUrl: const String.fromEnvironment('API_BASE_URL', defaultValue: 'http://10.0.2.2:3000'),
    // Base Sepolia
    chainId: const int.fromEnvironment('CHAIN_ID', defaultValue: 84532),
    // Optional, local chains only: a funded test key for the dev wallet's first start,
    // e.g. anvil account #4. Never a real key: dart-defines end up in the app binary.
    // kReleaseMode is a constant, so release builds drop this branch and the key with it.
    devWalletPrivateKey: kReleaseMode ? null : const String.fromEnvironment('DEV_WALLET_PRIVATE_KEY'),
    release: release,
  );

  /// Applies the release rules to raw settings: a release build refuses a non-https [apiBaseUrl]
  /// (an [ArgumentError] naming `API_BASE_URL`) and drops [devWalletPrivateKey]. An empty key means none.
  factory AppConfig.checked({
    required String apiBaseUrl,
    required int chainId,
    String? devWalletPrivateKey,
    required bool release,
  }) {
    if (release && !isHttps(apiBaseUrl)) {
      throw ArgumentError.value(apiBaseUrl, 'API_BASE_URL', 'release builds need an https:// URL');
    }
    final key = devWalletPrivateKey == null || devWalletPrivateKey.isEmpty ? null : devWalletPrivateKey;
    return AppConfig(apiBaseUrl: apiBaseUrl, chainId: chainId, devWalletPrivateKey: release ? null : key);
  }

  /// Whether [url] is an absolute https URL with a host.
  static bool isHttps(String url) {
    final uri = Uri.tryParse(url);
    return uri != null && uri.scheme == 'https' && uri.host.isNotEmpty;
  }

  final String apiBaseUrl;
  final int chainId;
  final String? devWalletPrivateKey;
}
