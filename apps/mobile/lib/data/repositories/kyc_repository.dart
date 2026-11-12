import 'package:globalpay/data/api/api_client.dart';
import 'package:globalpay/data/api/generated/export.dart' as dto;
import 'package:globalpay/domain/models/kyc.dart';
import 'package:globalpay/domain/models/money.dart';

/// Identity verification (POST /kyc/start, GET /kyc/status). The demo uses the backend's mock provider.
class KycRepository {
  const KycRepository({required this.api});

  final ApiClient api;

  Future<KycState> status() async {
    final response = await ApiClient.call(() => api.api.kyc.getKycStatus());
    return _toState(response.status.toJson(), response.tier, response.limits);
  }

  Future<KycState> start() async {
    final response = await ApiClient.call(() => api.api.kyc.startKyc());
    return _toState(response.status.toJson(), response.tier, response.limits);
  }

  KycState _toState(String status, int tier, dto.SpendingLimits limits) => KycState(
    status: KycStatus.fromApi(status),
    tier: tier,
    perPayment: FiatAmount(currency: FiatCurrency.thb, minor: BigInt.parse(limits.perPayment)),
    perDay: FiatAmount(currency: FiatCurrency.thb, minor: BigInt.parse(limits.perDay)),
  );
}
