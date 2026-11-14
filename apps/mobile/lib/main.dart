import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:globalpay/app/app.dart';
import 'package:globalpay/core/config/app_config.dart';
import 'package:globalpay/core/providers.dart';

void main() {
  // Read the settings first, so a misconfigured build (e.g. a release with a plain-http API) stops here.
  final config = AppConfig.fromEnvironment();
  runApp(ProviderScope(overrides: [appConfigProvider.overrideWithValue(config)], child: const GlobalPayApp()));
}
