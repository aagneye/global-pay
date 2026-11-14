import 'package:globalpay/data/api/api_client.dart';
import 'package:globalpay/data/api/generated/export.dart' as dto;
import 'package:globalpay/data/repositories/payments_repository.dart';
import 'package:globalpay/domain/models/onramp.dart';
import 'package:globalpay/domain/models/payment.dart';

/// "Add money" (POST /onramp/orders, GET /onramp/orders/{id}).
class OnrampRepository {
  const OnrampRepository({required this.api, required this.apiBaseUrl});

  final ApiClient api;

  /// AppConfig.apiBaseUrl, to resolve a relative checkout URL.
  final String apiBaseUrl;

  /// Starts an order for [fiatMinor] THB satang. The checkout page may be given relative to the API
  /// (the local simulator), so it's resolved against the API's base URL.
  Future<({OnrampOrder order, Uri checkoutUrl})> create(BigInt fiatMinor) async {
    final response = await ApiClient.call(
      () => api.api.onramp.createOnrampOrder(body: dto.OnrampOrderRequest(fiatAmountMinor: fiatMinor.toString())),
    );
    return (order: onrampOrderFromDto(response.order), checkoutUrl: resolveCheckoutUrl(apiBaseUrl, response.checkoutUrl));
  }

  /// Asks the backend, which checks with the partner if it's due.
  Future<OnrampOrder> get(String id) async =>
      onrampOrderFromDto(await ApiClient.call(() => api.api.onramp.getOnrampOrder(id: id)));
}

/// An absolute checkout URL as is; a relative one against the API's base URL.
Uri resolveCheckoutUrl(String apiBaseUrl, String checkoutUrl) => Uri.parse(apiBaseUrl).resolve(checkoutUrl);

OnrampOrder onrampOrderFromDto(dto.OnrampOrder response) => OnrampOrder(
  id: response.id,
  status: OnrampStatus.fromApi(response.status.toJson()),
  fiatAmount: thb(response.fiatAmount),
  createdAt: response.createdAt,
  tokenAmount: response.tokenAmount == null ? null : usdc(response.tokenAmount!),
  transaction: response.transaction == null ? null : TxLink(hash: response.transaction!.hash, url: response.transaction!.url),
  failureReason: response.failureReason,
);

Deposit depositFromDto(dto.Deposit response) => Deposit(
  id: response.id,
  amount: usdc(response.amount),
  from: response.from,
  transaction: TxLink(hash: response.transaction.hash, url: response.transaction.url),
  createdAt: response.createdAt,
  onrampOrderId: response.onrampOrderId,
);
