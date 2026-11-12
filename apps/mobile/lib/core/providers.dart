import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:globalpay/core/config/app_config.dart';
import 'package:globalpay/core/storage/secure_store.dart';
import 'package:globalpay/data/api/api_client.dart';
import 'package:globalpay/data/repositories/account_repository.dart';
import 'package:globalpay/data/repositories/auth_repository.dart';
import 'package:globalpay/data/repositories/kyc_repository.dart';
import 'package:globalpay/data/repositories/payments_repository.dart';
import 'package:globalpay/data/session_store.dart';
import 'package:globalpay/features/auth/session_controller.dart';
import 'package:globalpay/services/wallet/dev_wallet_service.dart';
import 'package:globalpay/services/wallet/wallet_service.dart';

/// Dependency graph. Tests override these with fakes through ProviderScope(overrides: ...).

final appConfigProvider = Provider<AppConfig>((ref) => AppConfig.fromEnvironment());

final secureStoreProvider = Provider<SecureStore>((ref) => const FlutterSecureStore());

final sessionStoreProvider = Provider<SessionStore>((ref) => SessionStore(ref.watch(secureStoreProvider)));

/// Switches to PrivyWalletService in iteration 7.
final walletServiceProvider = Provider<WalletService>(
  (ref) => DevWalletService(
    store: ref.watch(secureStoreProvider),
    importKey: ref.watch(appConfigProvider).devWalletPrivateKey,
  ),
);

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
  ),
);

final kycRepositoryProvider = Provider<KycRepository>((ref) => KycRepository(api: ref.watch(apiClientProvider)));

final paymentsRepositoryProvider = Provider<PaymentsRepository>(
  (ref) => PaymentsRepository(api: ref.watch(apiClientProvider)),
);

final accountRepositoryProvider = Provider<AccountRepository>(
  (ref) => AccountRepository(api: ref.watch(apiClientProvider)),
);
