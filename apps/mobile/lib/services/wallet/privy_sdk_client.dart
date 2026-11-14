import 'package:flutter/services.dart';
import 'package:globalpay/services/wallet/privy_client.dart';
import 'package:privy_flutter/privy_flutter.dart';

/// [PrivyClient] on the official Privy Flutter SDK (`privy_flutter` 0.11.0, which wraps Privy's
/// native Android and iOS SDKs). The only file that imports it.
///
/// Calls follow docs.privy.io/basics/flutter (setup, email login, embedded wallets, signing) and
/// the package's own API. Privy starts on first use, so builds without Privy IDs never load it.
class SdkPrivyClient implements PrivyClient {
  SdkPrivyClient(this.settings);

  final PrivySettings settings;

  // Log level stays at the default (none): Privy's debug logs include email codes.
  late final Privy _privy = Privy.init(
    config: PrivyConfig(appId: settings.appId, appClientId: settings.clientId),
  );

  @override
  Future<bool> isAuthenticated() => _call(PrivyFailure.unknown, () async {
    var state = await _privy.getAuthState();
    if (state is AuthenticatedUnverified) {
      // A saved session that couldn't be refreshed, usually because the phone was offline: retry once.
      await _privy.onNetworkRestored();
      state = await _privy.getAuthState();
    }
    return switch (state) {
      Authenticated() => true,
      AuthenticatedUnverified() => throw const PrivyClientException(
        PrivyFailure.offline,
        'The saved session could not be verified',
      ),
      _ => false,
    };
  });

  @override
  Future<void> sendEmailCode(String email) => _call(PrivyFailure.sendCode, () async {
    _unwrap(await _privy.email.sendCode(email), PrivyFailure.sendCode);
  });

  @override
  Future<void> loginWithEmailCode({required String email, required String code}) =>
      _call(PrivyFailure.invalidCode, () async {
        _unwrap(await _privy.email.loginWithCode(code: code, email: email), PrivyFailure.invalidCode);
      });

  @override
  Future<String> ethereumWallet() => _call(PrivyFailure.wallet, () async {
    final user = await _user();
    final wallets = user.embeddedEthereumWallets;
    if (wallets.isNotEmpty) {
      // The first HD wallet (index 0) is the user's GlobalPay wallet.
      return wallets.firstWhere((wallet) => wallet.hdWalletIndex == 0, orElse: () => wallets.first).address;
    }
    return _unwrap(await user.createEthereumWallet(), PrivyFailure.wallet).address;
  });

  @override
  Future<String> personalSign({required String address, required String message}) =>
      _call(PrivyFailure.signing, () async {
        final wallet = await _wallet(address);
        final request = EthereumRpcRequest.personalSign(message, wallet.address);
        return _unwrap(await wallet.provider.request(request), PrivyFailure.signing).data;
      });

  @override
  Future<String> signTypedDataV4({required String address, required String typedDataJson}) =>
      _call(PrivyFailure.signing, () async {
        final wallet = await _wallet(address);
        final request = EthereumRpcRequest.ethSignTypedDataV4(wallet.address, typedDataJson);
        return _unwrap(await wallet.provider.request(request), PrivyFailure.signing).data;
      });

  @override
  Future<void> logout() => _call(PrivyFailure.unknown, _privy.logout);

  Future<PrivyUser> _user() async =>
      await _privy.getUser() ?? (throw const PrivyClientException(PrivyFailure.notAuthenticated, 'No Privy user'));

  Future<EmbeddedEthereumWallet> _wallet(String address) async {
    for (final wallet in (await _user()).embeddedEthereumWallets) {
      if (wallet.address.toLowerCase() == address.toLowerCase()) return wallet;
    }
    throw const PrivyClientException(PrivyFailure.wallet, 'No embedded wallet with that address');
  }

  T _unwrap<T>(Result<T> result, PrivyFailure failure) => switch (result) {
    Success(:final value) => value,
    Failure(:final error) => throw PrivyClientException(classifyPrivyError(error, failure), error.message),
  };

  /// Runs an SDK call, turning whatever it throws into a [PrivyClientException].
  Future<T> _call<T>(PrivyFailure fallback, Future<T> Function() body) async {
    try {
      return await body();
    } on PrivyClientException {
      rethrow;
    } on PrivyException catch (error) {
      throw PrivyClientException(classifyPrivyError(error, fallback), error.message);
    } on PlatformException catch (error) {
      final converted = error.convertToPrivyException();
      throw PrivyClientException(classifyPrivyError(converted, fallback), converted.message);
    } on Exception catch (error) {
      // e.g. MissingPluginException: the native SDK isn't there.
      throw PrivyClientException(fallback, '$error');
    }
  }
}

/// Sorts a Privy SDK error into a [PrivyFailure]. [fallback] describes the call that failed.
PrivyFailure classifyPrivyError(PrivyException error, PrivyFailure fallback) => switch (error) {
  PrivyTimeoutException() || MfaSdkTimeoutException() => PrivyFailure.timeout,
  // USER_NOT_AUTHENTICATED and USER_NOT_FOUND from the native SDK.
  PrivyAuthException(stage: 'userAuth' || 'getUser') => PrivyFailure.notAuthenticated,
  // WALLET_NOT_FOUND and WALLET_CREATION_ERROR.
  PrivyWalletException(operation: 'unknown' || 'create') => PrivyFailure.wallet,
  _ => fallback,
};
