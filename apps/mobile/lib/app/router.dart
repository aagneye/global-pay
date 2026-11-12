import 'package:flutter/foundation.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:globalpay/domain/models/kyc.dart';
import 'package:globalpay/domain/models/promptpay_qr.dart';
import 'package:globalpay/domain/models/session.dart';
import 'package:globalpay/features/auth/login_screen.dart';
import 'package:globalpay/features/auth/session_controller.dart';
import 'package:globalpay/features/auth/splash_screen.dart';
import 'package:globalpay/features/history/history_screen.dart';
import 'package:globalpay/features/home/home_screen.dart';
import 'package:globalpay/features/kyc/kyc_controller.dart';
import 'package:globalpay/features/kyc/kyc_screen.dart';
import 'package:globalpay/features/pay/confirm_screen.dart';
import 'package:globalpay/features/pay/payment_status_screen.dart';
import 'package:globalpay/features/receive/receive_screen.dart';
import 'package:globalpay/features/scan/scan_screen.dart';

abstract final class Routes {
  static const splash = '/splash';
  static const login = '/login';
  static const kyc = '/kyc';
  static const home = '/';
  static const receive = '/receive';
  static const scan = '/scan';
  static const confirm = '/pay/confirm';
  static const history = '/history';

  static String status(String paymentId) => '/pay/status/$paymentId';
}

/// Where the app must go given the session and KYC state, or null to stay at [location].
///
/// Signed out → sign-in. Signed in but not verified → KYC. Verified → anywhere but sign-in and KYC.
/// While the saved session or the KYC state is loading, a splash screen shows.
String? guard({required AsyncValue<Session?> session, required AsyncValue<KycState?> kyc, required String location}) {
  String? goTo(String target) => location == target ? null : target;

  if (!session.hasValue) return session.hasError ? goTo(Routes.login) : goTo(Routes.splash);
  if (session.value == null) return goTo(Routes.login);

  final verification = kyc.value;
  if (verification == null) return kyc.hasError ? goTo(Routes.kyc) : goTo(Routes.splash);
  if (!verification.canPay) return goTo(Routes.kyc);

  const gates = [Routes.splash, Routes.login, Routes.kyc];
  return gates.contains(location) ? Routes.home : null;
}

final routerProvider = Provider<GoRouter>((ref) {
  final refresh = ValueNotifier<int>(0);
  ref.listen(sessionProvider, (_, _) => refresh.value++);
  ref.listen(kycProvider, (_, _) => refresh.value++);

  final router = GoRouter(
    initialLocation: Routes.splash,
    refreshListenable: refresh,
    redirect: (context, state) =>
        guard(session: ref.read(sessionProvider), kyc: ref.read(kycProvider), location: state.matchedLocation),
    routes: [
      GoRoute(path: Routes.splash, builder: (context, state) => const SplashScreen()),
      GoRoute(path: Routes.login, builder: (context, state) => const LoginScreen()),
      GoRoute(path: Routes.kyc, builder: (context, state) => const KycScreen()),
      GoRoute(path: Routes.home, builder: (context, state) => const HomeScreen()),
      GoRoute(path: Routes.receive, builder: (context, state) => const ReceiveScreen()),
      GoRoute(path: Routes.scan, builder: (context, state) => const ScanScreen()),
      GoRoute(
        path: Routes.confirm,
        // The scanned QR. Without it (e.g. a reload on the web), start again from the scanner.
        redirect: (context, state) => state.extra is PromptPayQr ? null : Routes.scan,
        builder: (context, state) => ConfirmScreen(qr: state.extra! as PromptPayQr),
      ),
      GoRoute(
        path: '/pay/status/:paymentId',
        builder: (context, state) => PaymentStatusScreen(paymentId: state.pathParameters['paymentId']!),
      ),
      GoRoute(path: Routes.history, builder: (context, state) => const HistoryScreen()),
    ],
  );
  ref.onDispose(() {
    router.dispose();
    refresh.dispose();
  });
  return router;
});
