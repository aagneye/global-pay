import 'dart:io';

import 'package:flutter_test/flutter_test.dart';

/// Release builds must not allow plain HTTP; only the debug source set may. These read the Android
/// sources (from apps/mobile, where `flutter test` runs).
void main() {
  const src = 'android/app/src';

  test('the main manifest does not enable cleartext traffic', () {
    final manifest = _read('$src/main/AndroidManifest.xml');
    final values = RegExp(r'usesCleartextTraffic\s*=\s*"([^"]*)"').allMatches(manifest).map((m) => m[1]);
    expect(values.where((v) => v != 'false'), isEmpty);
  });

  test('the main network security config allows HTTPS only', () {
    final manifest = _read('$src/main/AndroidManifest.xml');
    final name = RegExp(r'networkSecurityConfig\s*=\s*"@xml/([\w.]+)"').firstMatch(manifest)?[1];
    expect(name, isNotNull, reason: 'main/AndroidManifest.xml should set android:networkSecurityConfig');

    final config = _read('$src/main/res/xml/$name.xml');
    expect(config, matches(RegExp(r'<base-config[^>]*cleartextTrafficPermitted\s*=\s*"false"')));
    expect(_allowsCleartext(config), isFalse);
  });

  test('no source set but debug allows cleartext', () {
    final offenders = <String>[];
    for (final set in Directory(src).listSync().whereType<Directory>()) {
      if (set.path.split(RegExp(r'[\\/]')).last == 'debug') continue;
      final res = Directory('${set.path}/res');
      final files = [
        File('${set.path}/AndroidManifest.xml'),
        if (res.existsSync()) ...res.listSync(recursive: true).whereType<File>().where((f) => f.path.endsWith('.xml')),
      ];
      for (final file in files.where((f) => f.existsSync())) {
        if (_allowsCleartext(_read(file.path))) offenders.add(file.path);
      }
    }
    expect(offenders, isEmpty);
  });
}

String _read(String path) => File(path).readAsStringSync().replaceAll(RegExp(r'<!--.*?-->', dotAll: true), '');

bool _allowsCleartext(String xml) =>
    RegExp(r'(cleartextTrafficPermitted|usesCleartextTraffic)\s*=\s*"true"').hasMatch(xml);
