import 'package:flutter/foundation.dart';

/// Where payments settle: one rail per backend (its `SETTLEMENT_RAIL`).
enum SettlementRail {
  /// USDC on an EVM chain (Base Sepolia, or anvil locally): EIP-3009 authorisations.
  evm,

  /// Test USDC on NEAR testnet: NEP-413 sign-in and gasless NEP-366 meta transactions.
  near,
}

/// App settings from `--dart-define`, so the app ships no secrets.
///
/// Example: flutter run --dart-define=API_BASE_URL=http://10.0.2.2:3000
///
/// Release builds are stricter:
/// - `API_BASE_URL` must be https, or the app stops at startup. Android's cleartext setting doesn't
///   cover Dart's own HTTP client (Dio), so this check is what keeps plain HTTP out of a release.
/// - `DEV_WALLET_PRIVATE_KEY` is ignored, and not even compiled in, so a test key can't ship.
class AppConfig {
  const AppConfig({
    required this.apiBaseUrl,
    required this.chainId,
    this.devWalletPrivateKey,
    this.settlementAddress,
    this.settlementRail = SettlementRail.evm,
    this.nearUsdcContract,
    this.nearSettlementContract,
    this.nearSignInRecipient = defaultNearSignInRecipient,
  });

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
    // Optional: the GlobalPaySettlement contract. When set, the wallet won't sign a merchant payment to anything else.
    settlementAddress: const String.fromEnvironment('SETTLEMENT_ADDRESS'),
    // evm (default) or near: must match the backend's SETTLEMENT_RAIL.
    settlementRail: const String.fromEnvironment('SETTLEMENT_RAIL'),
    // Optional, NEAR rail: the test USDC and settlement contracts. When set, the wallet won't sign a payment
    // to any other token or recipient.
    nearUsdcContract: const String.fromEnvironment('NEAR_USDC_CONTRACT'),
    nearSettlementContract: const String.fromEnvironment('NEAR_SETTLEMENT_CONTRACT'),
    // NEAR rail: the NEP-413 recipient the backend expects (its SIWE_DOMAIN).
    nearSignInRecipient: const String.fromEnvironment('NEAR_SIGN_IN_RECIPIENT'),
    release: release,
  );

  /// Applies the release rules to raw settings: a release build refuses a non-https [apiBaseUrl]
  /// (an [ArgumentError] naming `API_BASE_URL`) and drops [devWalletPrivateKey]. An empty key means none.
  /// [settlementRail] is `evm` (also when empty) or `near`; anything else is an [ArgumentError] naming
  /// `SETTLEMENT_RAIL`. Empty NEAR settings mean unset.
  factory AppConfig.checked({
    required String apiBaseUrl,
    required int chainId,
    String? devWalletPrivateKey,
    String? settlementAddress,
    String? settlementRail,
    String? nearUsdcContract,
    String? nearSettlementContract,
    String? nearSignInRecipient,
    required bool release,
  }) {
    if (release && !isHttps(apiBaseUrl)) {
      throw ArgumentError.value(apiBaseUrl, 'API_BASE_URL', 'release builds need an https:// URL');
    }
    final rail = _orNull(settlementRail) == null
        ? SettlementRail.evm
        : SettlementRail.values.asNameMap()[settlementRail] ??
              (throw ArgumentError.value(settlementRail, 'SETTLEMENT_RAIL', 'must be evm or near'));
    final key = _orNull(devWalletPrivateKey);
    return AppConfig(
      apiBaseUrl: apiBaseUrl,
      chainId: chainId,
      devWalletPrivateKey: release ? null : key,
      settlementAddress: _orNull(settlementAddress),
      settlementRail: rail,
      nearUsdcContract: _orNull(nearUsdcContract),
      nearSettlementContract: _orNull(nearSettlementContract),
      nearSignInRecipient: _orNull(nearSignInRecipient) ?? defaultNearSignInRecipient,
    );
  }

  /// Whether [url] is an absolute https URL with a host.
  static bool isHttps(String url) {
    final uri = Uri.tryParse(url);
    return uri != null && uri.scheme == 'https' && uri.host.isNotEmpty;
  }

  static String? _orNull(String? value) => value == null || value.isEmpty ? null : value;

  /// The backend's default SIWE_DOMAIN.
  static const defaultNearSignInRecipient = 'globalpay.local';

  final String apiBaseUrl;
  final int chainId;
  final String? devWalletPrivateKey;

  /// Where merchant payments go (SETTLEMENT_ADDRESS). Null or empty: not checked before signing.
  final String? settlementAddress;

  /// EVM (the default) or NEAR testnet (SETTLEMENT_RAIL).
  final SettlementRail settlementRail;

  /// NEAR rail: the test USDC contract (NEAR_USDC_CONTRACT). Null: not checked before signing.
  final String? nearUsdcContract;

  /// NEAR rail: the settlement contract (NEAR_SETTLEMENT_CONTRACT). Null: not checked before signing.
  final String? nearSettlementContract;

  /// NEAR rail: the NEP-413 sign-in recipient (NEAR_SIGN_IN_RECIPIENT, default globalpay.local).
  final String nearSignInRecipient;

  bool get isNear => settlementRail == SettlementRail.near;

  /// A test network: NEAR testnet (the NEAR rail is testnet only), Base Sepolia or a local anvil chain. Only
  /// testnet builds offer the demo card key on phones without NFC.
  bool get isTestnet => isNear || chainId == 84532 || chainId == 31337;
}
