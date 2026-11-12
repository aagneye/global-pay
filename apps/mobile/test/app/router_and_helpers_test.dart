import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:globalpay/app/router.dart';
import 'package:globalpay/domain/models/kyc.dart';
import 'package:globalpay/domain/models/money.dart';
import 'package:globalpay/domain/models/quote.dart';
import 'package:globalpay/domain/models/session.dart';
import 'package:globalpay/features/pay/confirm_screen.dart';
import 'package:globalpay/features/receive/receive_screen.dart';

final session = AsyncData<Session?>(
  Session(token: 't', expiresAt: DateTime(2100), userId: 'u', walletAddress: '0xabc'),
);
KycState kyc(KycStatus status, int tier) => KycState(
  status: status,
  tier: tier,
  perPayment: FiatAmount(currency: FiatCurrency.thb, minor: BigInt.zero),
  perDay: FiatAmount(currency: FiatCurrency.thb, minor: BigInt.zero),
);

void main() {
  group('router guard', () {
    String? at(String location, AsyncValue<Session?> s, AsyncValue<KycState?> k) =>
        guard(session: s, kyc: k, location: location);

    test('shows the splash while the session or KYC loads', () {
      expect(at(Routes.home, const AsyncLoading(), const AsyncData(null)), Routes.splash);
      expect(at(Routes.home, session, const AsyncLoading()), Routes.splash);
      expect(at(Routes.splash, session, const AsyncLoading()), isNull);
    });

    test('sends signed-out users to sign-in', () {
      expect(at(Routes.home, const AsyncData(null), const AsyncData(null)), Routes.login);
      expect(at(Routes.login, const AsyncData(null), const AsyncData(null)), isNull);
      expect(at(Routes.scan, AsyncError(Exception(), StackTrace.empty), const AsyncData(null)), Routes.login);
    });

    test('sends unverified users to KYC', () {
      expect(at(Routes.scan, session, AsyncData(kyc(KycStatus.notStarted, 0))), Routes.kyc);
      expect(at(Routes.home, session, AsyncData(kyc(KycStatus.pending, 0))), Routes.kyc);
      expect(at(Routes.home, session, AsyncError(Exception(), StackTrace.empty)), Routes.kyc);
      expect(at(Routes.kyc, session, AsyncData(kyc(KycStatus.rejected, 0))), isNull);
    });

    test('lets verified users in, and out of the gates', () {
      final approved = AsyncData<KycState?>(kyc(KycStatus.approved, 1));
      expect(at(Routes.scan, session, approved), isNull);
      expect(at(Routes.kyc, session, approved), Routes.home);
      expect(at(Routes.login, session, approved), Routes.home);
      expect(at(Routes.splash, session, approved), Routes.home);
    });
  });

  test('parseThb reads baht amounts into satang', () {
    expect(parseThb('250'), BigInt.from(25000));
    expect(parseThb(' 59.5 '), BigInt.from(5950));
    expect(parseThb('0.01'), BigInt.one);
    for (final bad in ['', '0', '0.00', '1.005', '-1', 'abc', '1,000']) {
      expect(parseThb(bad), isNull, reason: bad);
    }
  });

  test('builds an EIP-681 USDC transfer link', () {
    expect(
      eip681TransferLink(token: '0xToken', chainId: 84532, recipient: '0xMe'),
      'ethereum:0xToken@84532/transfer?address=0xMe',
    );
  });

  test('formats the quote rate to two decimals', () {
    Quote quote(String rateE8) => Quote(
      quoteId: '0x',
      payer: '0x',
      tokenAmount: TokenAmount(symbol: 'USDC', units: BigInt.one, decimals: 6),
      feeAmount: TokenAmount(symbol: 'USDC', units: BigInt.zero, decimals: 6),
      fiatAmount: FiatAmount(currency: FiatCurrency.thb, minor: BigInt.one),
      rateE8: BigInt.parse(rateE8),
      spreadBps: 100,
      merchant: const QuoteMerchant(isMerchant: true, targetId: '1'),
      expiresAt: DateTime(2100),
      authorization: const AuthorizationToSign(typedData: {}, validAfter: '0', validBefore: '0'),
    );
    expect(quote('3376818073').formatRate(), '33.77 THB/USDC');
    expect(quote('3250000000').formatRate(), '32.50 THB/USDC');
  });
}
