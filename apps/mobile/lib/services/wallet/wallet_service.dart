/// The app's only way to talk to a wallet (see docs/adr/0003).
///
/// Implementations:
/// - [DevWalletService]: a local key in secure storage, for development and tests.
/// - [PrivyWalletService]: an embedded wallet with email/Google login.
///
/// All addresses and signatures are 0x-prefixed hex strings.
abstract interface class WalletService {
  /// Signs the user in (creating the wallet on first use) and returns its address.
  Future<String> connect();

  /// The connected wallet's address, or null when signed out.
  Future<String?> currentAddress();

  Future<void> disconnect();

  /// EIP-191 personal_sign. Used for Sign-In with Ethereum.
  Future<String> signMessage(String message);

  /// EIP-712 eth_signTypedData_v4. Used for the USDC ReceiveWithAuthorization of a quote.
  Future<String> signTypedData(Map<String, Object?> typedData);
}
