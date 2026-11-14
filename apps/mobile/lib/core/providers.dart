import 'package:flutter/foundation.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:url_launcher/url_launcher.dart';
import 'package:globalpay/core/config/app_config.dart';
import 'package:globalpay/core/storage/secure_store.dart';
import 'package:globalpay/data/api/api_client.dart';
import 'package:globalpay/data/repositories/account_repository.dart';
import 'package:globalpay/data/repositories/auth_repository.dart';
import 'package:globalpay/data/repositories/kyc_repository.dart';
import 'package:globalpay/data/repositories/onramp_repository.dart';
import 'package:globalpay/data/repositories/p2p_repository.dart';
import 'package:globalpay/services/push/push_service.dart';
import 'package:globalpay/services/tap/tap_services.dart';
import 'package:globalpay/data/repositories/payments_repository.dart';
import 'package:globalpay/data/session_store.dart';
import 'package:globalpay/features/auth/session_controller.dart';
import 'package:globalpay/services/wallet/dev_wallet_service.dart';
import 'package:globalpay/services/wallet/near/near_wallet_service.dart';
import 'package:globalpay/services/wallet/privy_client.dart';
import 'package:globalpay/services/wallet/privy_sdk_client.dart';
import 'package:globalpay/services/wallet/privy_wallet_service.dart';
import 'package:globalpay/services/wallet/signature_gate.dart';
import 'package:globalpay/services/wallet/wallet_service.dart';
import 'package:globalpay/services/wallet/wallet_switch.dart';

/// Dependency graph. Tests override these with fakes through ProviderScope(overrides: ...).

final appConfigProvider = Provider<AppConfig>((ref) => AppConfig.fromEnvironment());

final secureStoreProvider = Provider<SecureStore>((ref) => const FlutterSecureStore());

final sessionStoreProvider = Provider<SessionStore>((ref) => SessionStore(ref.watch(secureStoreProvider)));

/// The wallet everything signs with: the one the user signed in with (see [walletSwitchProvider]).
final walletServiceProvider = Provider<WalletService>((ref) => ref.watch(walletSwitchProvider));

/// Privy's embedded wallet (email sign-in), or null when PRIVY_APP_ID and PRIVY_CLIENT_ID aren't set.
final privyWalletProvider = Provider<PrivyWalletService?>((ref) {
  final settings = PrivySettings.fromEnvironment();
  return settings.isConfigured
      ? PrivyWalletService(SdkPrivyClient(settings), gate: ref.watch(signatureGateProvider))
      : null;
});

/// The fingerprint check before every Privy signature. Release builds refuse to sign on a phone without a
/// strong fingerprint (or face); debug builds skip the check there, so emulators can still sign.
final signatureGateProvider = Provider<SignatureGate>(
  (ref) => FingerprintGate(
    vault: ref.watch(keyVaultProvider),
    store: ref.watch(secureStoreProvider),
    requireBiometrics: kReleaseMode,
  ),
);

/// Whether the dev wallet (a local key) is offered: debug builds only. Tests override it.
final devWalletEnabledProvider = Provider<bool>((ref) => kDebugMode);

/// The wallets this build signs in with: Privy's embedded wallet and, in debug builds, the dev wallet.
/// With neither (a release build without Privy IDs), sign-in says it isn't set up.
final walletSwitchProvider = Provider<WalletSwitch>(
  (ref) => WalletSwitch(
    store: ref.watch(secureStoreProvider),
    embedded: ref.watch(privyWalletProvider),
    dev: ref.watch(devWalletEnabledProvider)
        ? DevWalletService(
            store: ref.watch(secureStoreProvider),
            importKey: ref.watch(appConfigProvider).devWalletPrivateKey,
            vault: ref.watch(keyVaultProvider),
          )
        : null,
  ),
);

/// The NEAR testnet wallet when the app runs on the NEAR rail (SETTLEMENT_RAIL=near); null on EVM.
/// Release builds keep its key only in the fingerprint vault; debug builds fall back to secure storage,
/// so emulators without a screen lock can still sign.
final nearWalletProvider = Provider<NearWalletService?>(
  (ref) => ref.watch(appConfigProvider).isNear
      ? NearWalletService(
          store: ref.watch(secureStoreProvider),
          vault: ref.watch(keyVaultProvider),
          requireVault: kReleaseMode,
        )
      : null,
);

/// The fingerprint-locked store for the wallet key (Android Keystore). Null disables it.
final keyVaultProvider = Provider<KeyVault?>((ref) => const ChannelKeyVault());

/// Tap to pay: this phone as a card (sender) and as a reader (receiver), and push.
final tapCardProvider = Provider<TapCard>((ref) => const ChannelTapCard());
final tapReaderProvider = Provider<TapReader>((ref) => NfcTapReader());
final pushServiceProvider = Provider<PushService>((ref) => FirebasePushService(FirebaseConfig.fromEnvironment()));

final apiClientProvider = Provider<ApiClient>((ref) {
  final sessions = ref.watch(sessionStoreProvider);
  return ApiClient(
    ref.watch(appConfigProvider),
    token: () => sessions.current?.token,
    // The token expired or was revoked: back to sign-in.
    onUnauthorized: () => ref.read(sessionProvider.notifier).expire(),
  );
});

final authRepositoryProvider = Provider<AuthRepository>(
  (ref) => AuthRepository(
    api: ref.watch(apiClientProvider),
    wallet: ref.watch(walletServiceProvider),
    sessions: ref.watch(sessionStoreProvider),
    near: ref.watch(nearWalletProvider),
    nearRecipient: ref.watch(appConfigProvider).nearSignInRecipient,
  ),
);

final kycRepositoryProvider = Provider<KycRepository>((ref) => KycRepository(api: ref.watch(apiClientProvider)));

final paymentsRepositoryProvider = Provider<PaymentsRepository>(
  (ref) => PaymentsRepository(api: ref.watch(apiClientProvider)),
);

final accountRepositoryProvider = Provider<AccountRepository>(
  (ref) => AccountRepository(api: ref.watch(apiClientProvider)),
);

final p2pRepositoryProvider = Provider<P2pRepository>((ref) => P2pRepository(api: ref.watch(apiClientProvider)));

final onrampRepositoryProvider = Provider<OnrampRepository>(
  (ref) => OnrampRepository(api: ref.watch(apiClientProvider), apiBaseUrl: ref.watch(appConfigProvider).apiBaseUrl),
);

/// Opens the partner's checkout in a Custom Tab (not a WebView, so the app can't see card details).
/// Returns false if no browser could open it. Tests replace it.
final checkoutLauncherProvider = Provider<Future<bool> Function(Uri)>(
  (ref) => (url) => launchUrl(url, mode: LaunchMode.inAppBrowserView),
);
