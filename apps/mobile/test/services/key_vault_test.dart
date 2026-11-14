import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:globalpay/core/errors/app_exception.dart';
import 'package:globalpay/services/tap/tap_services.dart';

Matcher throwsAppException(String code) => throwsA(isA<AppException>().having((error) => error.code, 'code', code));

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  const channel = MethodChannel('globalpay/vault');

  tearDown(
    () => TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger.setMockMethodCallHandler(channel, null),
  );

  test('reads the Android errors as cancelled, invalidated or failed', () async {
    for (final (android, app) in [
      ('cancelled', 'biometric_cancelled'),
      ('invalidated', 'biometric_invalidated'),
      ('failed', 'biometric_failed'),
    ]) {
      TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger.setMockMethodCallHandler(
        channel,
        (call) async => throw PlatformException(code: android, message: 'no'),
      );
      await expectLater(const ChannelKeyVault().open('iv:data', reason: 'r'), throwsAppException(app), reason: android);
    }
  });
}
