import 'package:globalpay/data/api/api_client.dart';
import 'package:globalpay/domain/models/money.dart';
import 'package:globalpay/domain/models/payment.dart';

/// The signed-in user's balance and history (GET /me/balance, GET /me/payments).
class AccountRepository {
  const AccountRepository({required this.api});

  final ApiClient api;

  static const _planned = 'Account API is planned for iteration 5';

  Future<TokenAmount> balance() => throw UnimplementedError(_planned);

  Future<List<Payment>> history() => throw UnimplementedError(_planned);
}
