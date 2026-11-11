import 'package:flutter/material.dart';

const _seed = Color(0xFF0E7C66);

ThemeData buildTheme(Brightness brightness) {
  final scheme = ColorScheme.fromSeed(seedColor: _seed, brightness: brightness);
  return ThemeData(colorScheme: scheme, useMaterial3: true);
}
