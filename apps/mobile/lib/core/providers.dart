import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:globalpay/core/config/app_config.dart';
import 'package:globalpay/data/api/api_client.dart';
import 'package:globalpay/data/repositories/account_repository.dart';
import 'package:globalpay/data/repositories/auth_repository.dart';
import 'package:globalpay/data/repositories/payments_repository.dart';
import 'package:globalpay/services/wallet/dev_wallet_service.dart';
import 'package:globalpay/services/wallet/wallet_service.dart';

/// Dependency graph. Tests override these with fakes through ProviderScope(overrides: ...).

final appConfigProvider = Provider<AppConfig>((ref) => AppConfig.fromEnvironment());

final apiClientProvider = Provider<ApiClient>((ref) => ApiClient(ref.watch(appConfigProvider)));

/// Switches to PrivyWalletService in iteration 7.
final walletServiceProvider = Provider<WalletService>((ref) => const DevWalletService());

final authRepositoryProvider = Provider<AuthRepository>(
  (ref) => AuthRepository(api: ref.watch(apiClientProvider), wallet: ref.watch(walletServiceProvider)),
);

final paymentsRepositoryProvider = Provider<PaymentsRepository>(
  (ref) => PaymentsRepository(api: ref.watch(apiClientProvider)),
);

final accountRepositoryProvider = Provider<AccountRepository>(
  (ref) => AccountRepository(api: ref.watch(apiClientProvider)),
);
