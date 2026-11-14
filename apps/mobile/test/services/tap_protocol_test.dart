import 'dart:convert';
import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:globalpay/core/errors/app_exception.dart';
import 'package:globalpay/features/p2p/p2p_support.dart';
import 'package:globalpay/services/tap/tap_protocol.dart';

Uint8List withStatus(List<int> data, int sw1, int sw2) => Uint8List.fromList([...data, sw1, sw2]);
Matcher appError(String code) => throwsA(isA<AppException>().having((e) => e.code, 'code', code));

void main() {
  final challenge = '0xab00ffcd${'11' * 28}';

  group('TapProtocol', () {
    test('selects GlobalPay\'s own application ID', () {
      expect(TapProtocol.selectApdu(), [0x00, 0xA4, 0x04, 0x00, 0x07, 0xF0, 0x47, 0x50, 0x41, 0x59, 0x00, 0x01, 0x00]);
    });

    test('sends the 32-byte challenge in the SIGN command', () {
      final apdu = TapProtocol.signApdu(TapProtocol.challengeBytes(challenge));
      expect(apdu.sublist(0, 5), [0x80, 0x10, 0x00, 0x00, 0x20]);
      expect(apdu.sublist(5, 9), [0xab, 0x00, 0xff, 0xcd]);
      expect(apdu, hasLength(38));
      expect(() => TapProtocol.challengeBytes('0x1234'), throwsArgumentError);
    });

    test('reads the device ID and the signature', () {
      expect(TapProtocol.parseDeviceId(withStatus(utf8.encode('device_7'), 0x90, 0x00)), 'device_7');
      expect(TapProtocol.parseSignature(withStatus([0x30, 0x44, 0x02, 0x20, 1, 2, 3, 4, 5, 6], 0x90, 0x00)), '0x30440220010203040506');
    });

    test('explains a phone that is not ready, has no GlobalPay, or refuses', () {
      expect(() => TapProtocol.parseDeviceId(withStatus([], 0x69, 0x85)), appError('tap_not_ready'));
      expect(() => TapProtocol.parseDeviceId(withStatus([], 0x6A, 0x82)), appError('tap_no_app'));
      expect(() => TapProtocol.parseSignature(withStatus([], 0x6D, 0x00)), appError('tap_failed'));
      expect(() => TapProtocol.parseDeviceId(Uint8List.fromList([0x90])), appError('tap_failed'));
    });
  });

  group('request QR and amounts', () {
    test('round-trips a request QR, and ignores anything else', () {
      final qr = encodeRequestQr('request_1', challenge);
      expect(parseRequestQr(qr), (id: 'request_1', challenge: challenge));
      expect(parseRequestQr('000201010212...'), isNull);
      expect(parseRequestQr('globalpay://pay?r=request_1&c=0x12'), isNull);
      expect(parseRequestQr('https://pay?r=request_1&c=$challenge'), isNull);
    });

    test('parses USDC amounts to base units', () {
      expect(parseUsdc('5'), BigInt.from(5000000));
      expect(parseUsdc('5.25'), BigInt.from(5250000));
      expect(parseUsdc('0.000001'), BigInt.one);
      expect(parseUsdc('0'), isNull);
      expect(parseUsdc('1.0000001'), isNull);
      expect(parseUsdc('abc'), isNull);
    });
  });
}
