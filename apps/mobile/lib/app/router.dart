import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:globalpay/features/auth/login_screen.dart';
import 'package:globalpay/features/history/history_screen.dart';
import 'package:globalpay/features/home/home_screen.dart';
import 'package:globalpay/features/kyc/kyc_screen.dart';
import 'package:globalpay/features/pay/confirm_screen.dart';
import 'package:globalpay/features/pay/payment_status_screen.dart';
import 'package:globalpay/features/receive/receive_screen.dart';
import 'package:globalpay/features/scan/scan_screen.dart';

abstract final class Routes {
  static const login = '/login';
  static const kyc = '/kyc';
  static const home = '/';
  static const receive = '/receive';
  static const scan = '/scan';
  static const confirm = '/pay/confirm';
  static const history = '/history';

  static String status(String paymentId) => '/pay/status/$paymentId';
}

/// App routes. An auth/KYC redirect guard is added with real sign-in (iteration 5).
final routerProvider = Provider<GoRouter>((ref) {
  final router = GoRouter(
    initialLocation: Routes.login,
    routes: [
      GoRoute(path: Routes.login, builder: (context, state) => const LoginScreen()),
      GoRoute(path: Routes.kyc, builder: (context, state) => const KycScreen()),
      GoRoute(path: Routes.home, builder: (context, state) => const HomeScreen()),
      GoRoute(path: Routes.receive, builder: (context, state) => const ReceiveScreen()),
      GoRoute(path: Routes.scan, builder: (context, state) => const ScanScreen()),
      GoRoute(path: Routes.confirm, builder: (context, state) => const ConfirmScreen()),
      GoRoute(
        path: '/pay/status/:paymentId',
        builder: (context, state) =>
            PaymentStatusScreen(paymentId: state.pathParameters['paymentId']!),
      ),
      GoRoute(path: Routes.history, builder: (context, state) => const HistoryScreen()),
    ],
  );
  ref.onDispose(router.dispose);
  return router;
});
