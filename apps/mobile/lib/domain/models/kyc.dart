import 'package:globalpay/domain/models/money.dart';

enum KycStatus {
  notStarted('NOT_STARTED'),
  pending('PENDING'),
  approved('APPROVED'),
  rejected('REJECTED');

  const KycStatus(this.apiValue);

  final String apiValue;

  static KycStatus fromApi(String value) => KycStatus.values.firstWhere(
    (status) => status.apiValue == value,
    orElse: () => throw ArgumentError.value(value, 'value', 'Unknown KYC status'),
  );
}

/// The user's identity verification and what it allows.
class KycState {
  const KycState({required this.status, required this.tier, required this.perPayment, required this.perDay});

  final KycStatus status;

  /// 0 until approved; 0 can't pay.
  final int tier;
  final FiatAmount perPayment;

  /// Rolling 24 hours.
  final FiatAmount perDay;

  bool get canPay => status == KycStatus.approved && tier > 0;
}
