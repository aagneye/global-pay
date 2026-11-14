import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:globalpay/app/router.dart';
import 'package:globalpay/app/theme.dart';
import 'package:globalpay/features/p2p/p2p_support.dart';

class GlobalPayApp extends ConsumerWidget {
  const GlobalPayApp({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    // A tapped payment-request notification (or one that arrives while open): show it for approval.
    ref.listen(pushRequestsProvider, (_, next) {
      if (next case AsyncData(:final value)) ref.read(routerProvider).push(Routes.approve(value));
    });
    return MaterialApp.router(
      title: 'GlobalPay',
      theme: buildTheme(Brightness.light),
      darkTheme: buildTheme(Brightness.dark),
      routerConfig: ref.watch(routerProvider),
    );
  }
}
