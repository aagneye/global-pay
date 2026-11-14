import 'dart:io';

import 'package:flutter_test/flutter_test.dart';

/// Log hygiene: the app writes nothing to the console or logcat, because a stray log line could leak a
/// session token, a signature, a key or a QR payload (release builds keep `print` and `debugPrint`).
/// Show problems in the UI or throw an AppException instead. The `avoid_print` lint only covers `print`.
void main() {
  test('the Dart code has no print, debugPrint, dart:developer log or HTTP logging', () {
    final pattern = RegExp(
      r'\b(print|debugPrint|debugPrintStack)\s*\(|(?<![\w.])log\s*\(|dart:developer|LogInterceptor|\b(stdout|stderr)\s*\.',
    );
    expect(_offenders(Directory('lib'), const ['.dart'], pattern), isEmpty);
  });

  test('the native Android code has no logcat or console output', () {
    final pattern = RegExp(r'\bLog\.(v|d|i|w|e|wtf)\s*\(|\bprintln\s*\(|printStackTrace\s*\(|System\.(out|err)\b');
    expect(_offenders(Directory('android/app/src'), const ['.kt', '.java'], pattern), isEmpty);
  });
}

/// "path:line: text" for every non-comment line of the matching files that matches [pattern].
List<String> _offenders(Directory root, List<String> extensions, RegExp pattern) => [
  for (final file in root.listSync(recursive: true).whereType<File>())
    if (extensions.any(file.path.endsWith) && !file.path.endsWith('GeneratedPluginRegistrant.java'))
      for (final (i, line) in file.readAsLinesSync().indexed)
        if (!_isComment(line) && pattern.hasMatch(line)) '${file.path}:${i + 1}: ${line.trim()}',
];

bool _isComment(String line) {
  final text = line.trimLeft();
  return text.startsWith('//') || text.startsWith('*') || text.startsWith('/*');
}
