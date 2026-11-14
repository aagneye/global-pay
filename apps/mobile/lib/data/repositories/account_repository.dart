import 'package:globalpay/data/api/api_client.dart';
import 'package:globalpay/data/repositories/onramp_repository.dart';
import 'package:globalpay/data/repositories/payments_repository.dart';
import 'package:globalpay/domain/models/money.dart';
import 'package:globalpay/domain/models/onramp.dart';
import 'package:globalpay/domain/models/payment.dart';

/// The signed-in user's balance and history (GET /me/balance, /me/payments, /me/deposits).
class AccountRepository {
  const AccountRepository({required this.api});

  final ApiClient api;

  /// USDC in the wallet, read from the chain by the backend.
  Future<({TokenAmount amount, String token})> balance() async {
    final response = await ApiClient.call(() => api.api.account.getBalance());
    return (
      amount: TokenAmount(symbol: 'USDC', units: BigInt.parse(response.units), decimals: response.decimals),
      token: response.token,
    );
  }

  /// Newest first.
  Future<List<Payment>> history() async {
    final response = await ApiClient.call(() => api.api.account.listPayments());
    return response.payments.map(paymentFromDto).toList();
  }

  /// USDC that came in from outside, newest first.
  Future<List<Deposit>> deposits() async {
    final response = await ApiClient.call(() => api.api.account.listDeposits());
    return response.deposits.map(depositFromDto).toList();
  }
}
