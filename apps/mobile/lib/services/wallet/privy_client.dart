/// What GlobalPay needs from the Privy SDK. [PrivyWalletService] uses only this, so tests run it
/// against a fake without native code. [SdkPrivyClient] is the real one (privy_flutter).
///
/// Failures are thrown as [PrivyClientException]s.
abstract interface class PrivyClient {
  /// Whether a Privy user is signed in, including a session restored from an earlier launch.
  /// Waits for the SDK to finish starting.
  Future<bool> isAuthenticated();

  /// Emails a one-time code to [email].
  Future<void> sendEmailCode(String email);

  /// Signs in with the code from the email.
  Future<void> loginWithEmailCode({required String email, required String code});

  /// The signed-in user's embedded Ethereum wallet address. Creates the wallet on first use.
  Future<String> ethereumWallet();

  /// EIP-191 `personal_sign` of the UTF-8 [message] with the wallet at [address].
  Future<String> personalSign({required String address, required String message});

  /// EIP-712 `eth_signTypedData_v4` of [typedDataJson] (the typed data as a JSON string).
  Future<String> signTypedDataV4({required String address, required String typedDataJson});

  /// Signs the Privy user out. Their wallet stays with Privy: signing in again with the same email returns it.
  Future<void> logout();
}

/// What went wrong in a [PrivyClient] call, in terms the app can explain to the user.
enum PrivyFailure {
  /// No Privy user is signed in (or the session ended).
  notAuthenticated,

  /// The email code couldn't be sent (e.g. an invalid address).
  sendCode,

  /// The email code was wrong or expired.
  invalidCode,

  /// The embedded wallet couldn't be found or created.
  wallet,

  /// The wallet refused or failed to sign.
  signing,

  /// The SDK didn't answer in time.
  timeout,

  /// A saved session exists but couldn't be checked (usually no network).
  offline,

  unknown,
}

class PrivyClientException implements Exception {
  const PrivyClientException(this.failure, this.message);

  final PrivyFailure failure;

  /// The SDK's own message, for logs. Not shown to users.
  final String message;

  @override
  String toString() => 'PrivyClientException(${failure.name}): $message';
}

/// The Privy app's IDs from `--dart-define`s: PRIVY_APP_ID and PRIVY_CLIENT_ID
/// (Privy dashboard → App settings → Basics, and → Clients). Both are public identifiers, not secrets.
class PrivySettings {
  const PrivySettings({required this.appId, required this.clientId});

  factory PrivySettings.fromEnvironment() => const PrivySettings(
    appId: String.fromEnvironment('PRIVY_APP_ID'),
    clientId: String.fromEnvironment('PRIVY_CLIENT_ID'),
  );

  final String appId;
  final String clientId;

  bool get isConfigured => appId.isNotEmpty && clientId.isNotEmpty;
}
