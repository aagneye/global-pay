import 'package:globalpay/services/wallet/privy_client.dart';

/// A stand-in for the Privy SDK: one email account whose code is [validCode] and whose embedded
/// wallet is [walletAddress]. Records calls, and can fail any call once.
class FakePrivyClient implements PrivyClient {
  FakePrivyClient({
    this.walletAddress = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8',
    this.validCode = '123456',
    this.authenticated = false,
    this.hasWallet = false,
  });

  final String walletAddress;
  final String validCode;
  bool authenticated;
  bool hasWallet;

  /// What the signing calls return.
  String signature = '0x${'ab' * 65}';

  final calls = <String>[];
  final codesSentTo = <String>[];
  int walletsCreated = 0;

  /// The arguments of each signing call: (method, address, payload).
  final signed = <(String, String, String)>[];

  /// Makes the next call to the named method throw.
  final failures = <String, PrivyFailure>{};

  String? _pendingEmail;

  void _record(String call) {
    calls.add(call);
    final failure = failures.remove(call);
    if (failure != null) throw PrivyClientException(failure, 'fake $call failure');
  }

  @override
  Future<bool> isAuthenticated() async {
    _record('isAuthenticated');
    return authenticated;
  }

  @override
  Future<void> sendEmailCode(String email) async {
    _record('sendEmailCode');
    codesSentTo.add(email);
    _pendingEmail = email;
  }

  @override
  Future<void> loginWithEmailCode({required String email, required String code}) async {
    _record('loginWithEmailCode');
    if (email != _pendingEmail || code != validCode) {
      throw const PrivyClientException(PrivyFailure.invalidCode, 'Invalid code');
    }
    authenticated = true;
  }

  @override
  Future<String> ethereumWallet() async {
    _record('ethereumWallet');
    if (!authenticated) throw const PrivyClientException(PrivyFailure.notAuthenticated, 'No user');
    if (!hasWallet) {
      hasWallet = true;
      walletsCreated++;
    }
    return walletAddress;
  }

  @override
  Future<String> personalSign({required String address, required String message}) async {
    _record('personalSign');
    signed.add(('personal_sign', address, message));
    return signature;
  }

  @override
  Future<String> signTypedDataV4({required String address, required String typedDataJson}) async {
    _record('signTypedDataV4');
    signed.add(('eth_signTypedData_v4', address, typedDataJson));
    return signature;
  }

  @override
  Future<void> logout() async {
    _record('logout');
    authenticated = false;
  }
}
