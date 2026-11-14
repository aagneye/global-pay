import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:go_router/go_router.dart';
import 'package:globalpay/app/router.dart';
import 'package:globalpay/core/storage/secure_store.dart';
import 'package:globalpay/domain/models/payment_qr.dart';
import 'package:globalpay/domain/models/upi_qr.dart';
import 'package:globalpay/domain/promptpay/promptpay_parser.dart';
import 'package:globalpay/features/scan/scan_screen.dart';
import 'package:mobile_scanner/mobile_scanner.dart';

import '../near_flow_test.dart' show continueWithNear, nearApp, pumpUntil, qr250, start, tap;
import '../support/fake_backend.dart';
import '../support/near_vectors.dart';
import '../support/spy_near_wallet.dart';

/// A static personal PromptPay QR (no amount), from packages/fixtures/promptpay.
const staticPromptPay = '00020101021129370016A0000006770101110113006681234567853037645802TH6304823E';

/// A dynamic UPI merchant QR for ₹120.50.
const upiDynamic = 'upi://pay?pa=chaipoint@okicici&pn=Chai%20Point&am=120.50&cu=INR&mc=5812&tr=CHAI43';

String withCrc(String body) => '${body}6304${crc16('${body}6304')}';

/// The scanner alone, with a stand-in confirm screen that records every QR it is opened with.
Widget scanner({required List<PaymentQr> opened, bool camera = false}) {
  final router = GoRouter(
    initialLocation: Routes.scan,
    routes: [
      GoRoute(path: Routes.home, builder: (context, state) => const Text('home')),
      GoRoute(path: Routes.scan, builder: (context, state) => const ScanScreen()),
      GoRoute(
        path: Routes.confirm,
        builder: (context, state) => _Opened(qr: state.extra! as PaymentQr, opened: opened),
      ),
    ],
  );
  return ProviderScope(
    overrides: [cameraScannerProvider.overrideWithValue(camera)],
    child: MaterialApp.router(routerConfig: router),
  );
}

class _Opened extends StatefulWidget {
  const _Opened({required this.qr, required this.opened});

  final PaymentQr qr;
  final List<PaymentQr> opened;

  @override
  State<_Opened> createState() => _OpenedState();
}

class _OpenedState extends State<_Opened> {
  @override
  void initState() {
    super.initState();
    widget.opened.add(widget.qr);
  }

  @override
  Widget build(BuildContext context) => Scaffold(body: Text('Confirm ${widget.qr.payeeName}'));
}

/// A phone-sized view, so the paste field sits on screen below the camera square.
Future<void> show(WidgetTester tester, Widget app) async {
  tester.view.physicalSize = const Size(1080, 2400);
  tester.view.devicePixelRatio = 2.5;
  addTearDown(tester.view.reset);
  await tester.pumpWidget(app);
}

/// Unmounts the app inside the test, so the scanner stops while the fake camera is still there.
Future<void> unmount(WidgetTester tester) async {
  await tester.pumpWidget(const SizedBox());
  await tester.pump(const Duration(milliseconds: 50));
}

Future<void> frames(WidgetTester tester) async {
  for (var i = 0; i < 10; i++) {
    await tester.pump(const Duration(milliseconds: 50));
  }
}

Future<void> paste(WidgetTester tester, String text) async {
  await tester.enterText(find.byKey(const Key('qr-text')), text);
  await tester.tap(find.text('Continue'));
  await tester.pump();
}

/// The error shown under the paste field, or null.
String? fieldError(WidgetTester tester) =>
    tester.widget<TextField>(find.byKey(const Key('qr-text'))).decoration?.errorText;

const _method = MethodChannel('dev.steenbakker.mobile_scanner/scanner/method');
const _events = EventChannel('dev.steenbakker.mobile_scanner/scanner/event');
const _orientation = EventChannel('dev.steenbakker.mobile_scanner/scanner/deviceOrientation');

/// Stands in for mobile_scanner's native side: [authorized] or not, and [granted] when asked.
/// Returns the sink for barcode events once the scanner listens.
List<MockStreamHandlerEventSink> fakeCamera(WidgetTester tester, {required bool authorized, bool granted = false}) {
  final messenger = tester.binding.defaultBinaryMessenger;
  final sinks = <MockStreamHandlerEventSink>[];
  messenger.setMockMethodCallHandler(_method, (call) async {
    return switch (call.method) {
      'state' => authorized ? 1 : 2,
      'request' => granted,
      'start' => <String, Object?>{
        'textureId': 1,
        'numberOfCameras': 1,
        'currentTorchState': 0,
        'cameraDirection': 1,
        'size': <String, Object?>{'width': 720.0, 'height': 1280.0},
      },
      _ => null,
    };
  });
  messenger.setMockStreamHandler(_events, MockStreamHandler.inline(onListen: (args, sink) => sinks.add(sink)));
  messenger.setMockStreamHandler(_orientation, MockStreamHandler.inline(onListen: (args, sink) {}));
  addTearDown(() {
    messenger.setMockMethodCallHandler(_method, null);
    messenger.setMockStreamHandler(_events, null);
    messenger.setMockStreamHandler(_orientation, null);
  });
  return sinks;
}

void main() {
  group('paste path', () {
    testWidgets('without a camera the paste field and Continue are there, and no scanner is built', (tester) async {
      await show(tester, scanner(opened: []));
      await tester.pumpAndSettle();
      expect(find.byType(MobileScanner), findsNothing);
      expect(find.byKey(const Key('qr-text')), findsOneWidget);
      expect(find.text('Continue'), findsOneWidget);
      expect(find.textContaining('PromptPay (Thailand) or UPI (India)'), findsOneWidget);
    });

    testWidgets('empty or whitespace-only input shows an error and opens nothing', (tester) async {
      final opened = <PaymentQr>[];
      await show(tester, scanner(opened: opened));
      await tester.pumpAndSettle();
      for (final input in ['', '   ', '\n\t']) {
        await paste(tester, input);
        expect(fieldError(tester), 'QR has no checksum', reason: input.codeUnits.toString());
      }
      expect(opened, isEmpty);
      expect(find.byType(ScanScreen), findsOneWidget);
    });

    final unknown = <String, (String, String)>{
      'a web link': ('https://example.com/pay?amount=10', 'QR has no checksum'),
      'a Wi-Fi QR': ('WIFI:T:WPA;S:CafeGuest;P:secret;;', 'QR has no checksum'),
      'plain text': ('hello world', 'QR has no checksum'),
      'a UPI collect link': ('upi://collect?pa=shop@paytm', 'This is not a UPI payment QR.'),
      'a UPI QR in dollars': ('upi://pay?pa=shop@paytm&am=1&cu=USD', 'This UPI QR is in USD. Only rupees (INR) are supported.'),
      'a UPI QR with a bad amount': ('upi://pay?pa=shop@paytm&am=1.234', '"1.234" is not a valid amount.'),
      'a UPI QR without pa': ('UPI://PAY?pn=Shop', 'This UPI QR has no UPI ID (pa).'),
      'an EMV QR that is not PromptPay': (
        withCrc('00020101021126370016A000000677010199011300668123456785303764' '5802TH'),
        'Not a PromptPay QR',
      ),
      'a PromptPay QR in dollars': (
        withCrc('00020101021129370016A000000677010111011300668123456785303840' '5802TH'),
        'Only Thai baht (THB) QRs are supported',
      ),
      'a PromptPay QR with a bad checksum': (qr250.replaceFirst('250.00', '950.00'), 'QR checksum does not match'),
      'a truncated PromptPay QR': (qr250.substring(0, 60), 'QR has no checksum'),
      'a GlobalPay request link with a bad challenge': ('globalpay://pay?r=request_1&c=0x12', 'QR has no checksum'),
    };
    for (final MapEntry(key: name, value: (input, message)) in unknown.entries) {
      testWidgets('$name shows a clear error and stays on the scanner', (tester) async {
        final opened = <PaymentQr>[];
        await show(tester, scanner(opened: opened));
        await tester.pumpAndSettle();
        await paste(tester, input);
        await tester.pumpAndSettle();
        expect(fieldError(tester), message);
        expect(find.text(message), findsOneWidget);
        expect(opened, isEmpty);
        expect(find.byType(ScanScreen), findsOneWidget);
      });
    }

    testWidgets('the error clears as soon as the text changes', (tester) async {
      await show(tester, scanner(opened: []));
      await tester.pumpAndSettle();
      await paste(tester, 'nope');
      expect(fieldError(tester), isNotNull);
      await tester.enterText(find.byKey(const Key('qr-text')), 'nope!');
      await tester.pump();
      expect(fieldError(tester), isNull);
    });

    testWidgets('after an error a good QR still opens the confirm screen', (tester) async {
      final opened = <PaymentQr>[];
      await show(tester, scanner(opened: opened));
      await tester.pumpAndSettle();
      await paste(tester, 'upi://pay?pa=x');
      expect(fieldError(tester), '"x" is not a valid UPI ID.');
      await paste(tester, upiDynamic);
      await tester.pumpAndSettle();
      expect(opened, hasLength(1));
      expect(find.text('Confirm Chai Point'), findsOneWidget);
    });

    testWidgets('pressing Continue twice on the same QR opens the confirm screen once', (tester) async {
      final opened = <PaymentQr>[];
      await show(tester, scanner(opened: opened));
      await tester.pumpAndSettle();
      await tester.enterText(find.byKey(const Key('qr-text')), qr250);
      // Two taps before the next frame, as a double tap would deliver them.
      await tester.tap(find.text('Continue'));
      await tester.tap(find.text('Continue'));
      await tester.pumpAndSettle();
      expect(opened, hasLength(1));
      expect(find.byType(ScanScreen), findsNothing);
    });

    testWidgets('a pasted UPI QR with spaces and newlines around it opens with the trimmed payload', (tester) async {
      final opened = <PaymentQr>[];
      await show(tester, scanner(opened: opened));
      await tester.pumpAndSettle();
      await paste(tester, ' \r\n$upiDynamic\n\t');
      await tester.pumpAndSettle();
      final qr = opened.single as UpiQr;
      expect(qr.raw, upiDynamic);
      expect(qr.amount!.format(), '₹120.50');
    });
  });

  group('camera', () {
    Map<String, Object?> barcode(String rawValue) => {
      'name': 'barcode',
      'data': [
        {'rawValue': rawValue, 'format': BarcodeFormat.qrCode.rawValue},
      ],
    };

    testWidgets('permission denied: says the camera is unavailable, and pasting still works', (tester) async {
      fakeCamera(tester, authorized: false, granted: false);
      final opened = <PaymentQr>[];
      await show(tester, scanner(opened: opened, camera: true));
      await frames(tester);
      expect(find.byType(MobileScanner), findsOneWidget);
      expect(find.text('Camera unavailable (permissionDenied). Paste the QR text below instead.'), findsOneWidget);

      await paste(tester, qr250);
      await frames(tester);
      expect(opened, hasLength(1));
      expect(find.text('Confirm GLOBALPAY TEST CAFE'), findsOneWidget);
    });

    testWidgets('permission denied: a bad paste still shows its own error under the field', (tester) async {
      fakeCamera(tester, authorized: false, granted: false);
      final opened = <PaymentQr>[];
      await show(tester, scanner(opened: opened, camera: true));
      await frames(tester);
      await paste(tester, '');
      expect(fieldError(tester), 'QR has no checksum');
      expect(find.textContaining('Camera unavailable'), findsOneWidget);
      expect(opened, isEmpty);
      await unmount(tester);
    });

    testWidgets('the same QR detected twice is handled once', (tester) async {
      final sinks = fakeCamera(tester, authorized: true);
      final opened = <PaymentQr>[];
      await show(tester, scanner(opened: opened, camera: true));
      await frames(tester);
      expect(sinks, isNotEmpty, reason: 'the scanner listens for barcodes once started');
      sinks.last.success(barcode(qr250));
      sinks.last.success(barcode(qr250));
      await frames(tester);
      expect(opened, hasLength(1));
      expect(find.text('Confirm GLOBALPAY TEST CAFE'), findsOneWidget);
    });

    testWidgets('a detected QR that is not payable shows its error, and the next good one goes through', (
      tester,
    ) async {
      final sinks = fakeCamera(tester, authorized: true);
      final opened = <PaymentQr>[];
      await show(tester, scanner(opened: opened, camera: true));
      await frames(tester);
      sinks.last.success(barcode('upi://pay?pa=shop@paytm&cu=USD'));
      await frames(tester);
      expect(fieldError(tester), 'This UPI QR is in USD. Only rupees (INR) are supported.');
      expect(opened, isEmpty);

      sinks.last.success(barcode(upiDynamic));
      await frames(tester);
      expect(opened, hasLength(1));
      expect(find.text('Confirm Chai Point'), findsOneWidget);
    });
  });

  group('confirm screen: static QRs ask for the amount, dynamic QRs lock it', () {
    Future<FakeBackend> scanOnNear(WidgetTester tester, String qr) async {
      final backend = FakeBackend(near: true)..kycStatus = 'APPROVED';
      final store = MemorySecureStore();
      await start(tester, nearApp(backend, store, SpyNearWallet(store: store, importSeed: nearTestSeed)));
      await pumpUntil(tester, find.text(continueWithNear));
      await tap(tester, continueWithNear);
      await pumpUntil(tester, find.text('Scan & pay'));
      await tap(tester, 'Scan & pay');
      await pumpUntil(tester, find.byKey(const Key('qr-text')));
      await tester.enterText(find.byKey(const Key('qr-text')), qr);
      await tap(tester, 'Continue');
      return backend;
    }

    List<Map<dynamic, dynamic>> quotes(FakeBackend backend) => [
      for (final r in backend.requests)
        if (r.path == '/quotes') r.body as Map,
    ];

    testWidgets('a dynamic UPI QR: the ₹ amount is fixed, there is no amount field, and it quotes at once', (
      tester,
    ) async {
      final backend = await scanOnNear(tester, upiDynamic);
      await pumpUntil(tester, find.text('Pay 2.994012 USDC'));
      expect(find.byKey(const Key('amount')), findsNothing);
      expect(find.text('₹120.50'), findsWidgets);
      expect(find.text('Get quote'), findsNothing);
      final quote = quotes(backend).single;
      expect(quote['qrPayload'], upiDynamic);
      expect(quote['fiatAmountMinor'], isNull);
    });

    testWidgets('a static PromptPay QR: asks for baht, refuses bad amounts without quoting, then locks', (
      tester,
    ) async {
      final backend = await scanOnNear(tester, staticPromptPay);
      await pumpUntil(tester, find.byKey(const Key('amount')));
      expect(find.text('Amount in baht'), findsOneWidget);
      expect(find.text('฿'), findsOneWidget);

      for (final bad in ['', '0', '0.00', '-5', '12.345', 'abc', '1,000']) {
        await tester.enterText(find.byKey(const Key('amount')), bad);
        await tap(tester, 'Get quote');
        await tester.pump(const Duration(milliseconds: 50));
        expect(find.text('Enter an amount in baht, e.g. 120 or 59.50'), findsOneWidget, reason: '"$bad"');
      }
      expect(quotes(backend), isEmpty);

      await tester.enterText(find.byKey(const Key('amount')), ' 120.5 ');
      await tap(tester, 'Get quote');
      await pumpUntil(tester, find.text('Pay 7.477454 USDC'));
      expect(quotes(backend).single['fiatAmountMinor'], '12050');
      expect(find.text('Enter an amount in baht, e.g. 120 or 59.50'), findsNothing);
      // Once quoted, the amount can't be changed under the quote.
      expect(tester.widget<TextField>(find.byKey(const Key('amount'))).enabled, isFalse);
    });

    testWidgets('a static PromptPay QR (initiation 11) that carries an amount locks it too', (tester) async {
      final qr = withCrc('00020101021129370016A000000677010111011300668123456785303764' '540540.00' '5802TH');
      final backend = await scanOnNear(tester, qr);
      await pumpUntil(tester, find.text('Pay 7.477454 USDC'));
      expect(find.byKey(const Key('amount')), findsNothing);
      expect(find.text('฿40.00'), findsOneWidget);
      expect(quotes(backend).single['fiatAmountMinor'], isNull);
    });

    testWidgets('a dynamic PromptPay QR (initiation 12) without an amount asks for it', (tester) async {
      final qr = withCrc('00020101021229370016A000000677010111011300668123456785303764' '5802TH');
      final backend = await scanOnNear(tester, qr);
      await pumpUntil(tester, find.byKey(const Key('amount')));
      expect(find.text('Get quote'), findsOneWidget);
      expect(quotes(backend), isEmpty);
    });

    testWidgets('a QR pasted with spaces and newlines around it is quoted with the trimmed payload', (tester) async {
      final backend = await scanOnNear(tester, '  \r\n$qr250\n  ');
      await pumpUntil(tester, find.text('Pay 7.477454 USDC'));
      expect(quotes(backend).single['qrPayload'], qr250);
    });

    testWidgets('pressing Continue twice in the app requests one quote', (tester) async {
      final backend = FakeBackend(near: true)..kycStatus = 'APPROVED';
      final store = MemorySecureStore();
      await start(tester, nearApp(backend, store, SpyNearWallet(store: store, importSeed: nearTestSeed)));
      await pumpUntil(tester, find.text(continueWithNear));
      await tap(tester, continueWithNear);
      await pumpUntil(tester, find.text('Scan & pay'));
      await tap(tester, 'Scan & pay');
      await pumpUntil(tester, find.byKey(const Key('qr-text')));
      await tester.enterText(find.byKey(const Key('qr-text')), qr250);
      await tester.tap(find.text('Continue'));
      await tester.tap(find.text('Continue'));
      await pumpUntil(tester, find.text('Pay 7.477454 USDC'));
      await tester.pump(const Duration(milliseconds: 500));
      expect(quotes(backend), hasLength(1));
      expect(find.text('Confirm payment'), findsOneWidget);
    });
  });
}
