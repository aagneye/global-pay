import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:globalpay/app/router.dart';
import 'package:globalpay/domain/promptpay/promptpay_parser.dart';
import 'package:mobile_scanner/mobile_scanner.dart';

/// Whether to open the camera. Off in widget tests, which have no camera.
final cameraScannerProvider = Provider<bool>((ref) => true);

/// Scan a PromptPay QR with the camera, or paste its text (handy on emulators and the web).
/// The QR is checked here for instant feedback; the backend checks it again before quoting.
class ScanScreen extends ConsumerStatefulWidget {
  const ScanScreen({super.key});

  @override
  ConsumerState<ScanScreen> createState() => _ScanScreenState();
}

class _ScanScreenState extends ConsumerState<ScanScreen> {
  final _text = TextEditingController();
  MobileScannerController? _camera;
  String? _error;
  bool _handled = false;

  @override
  void initState() {
    super.initState();
    if (ref.read(cameraScannerProvider)) {
      _camera = MobileScannerController(
        formats: const [BarcodeFormat.qrCode],
        detectionSpeed: DetectionSpeed.noDuplicates,
      );
    }
  }

  @override
  void dispose() {
    _text.dispose();
    _camera?.dispose();
    super.dispose();
  }

  void _use(String payload) {
    if (_handled) return;
    try {
      final qr = parsePromptPayQr(payload);
      _handled = true;
      context.pushReplacement(Routes.confirm, extra: qr);
    } on PromptPayParseException catch (e) {
      setState(() => _error = e.message);
    }
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final camera = _camera;
    return Scaffold(
      appBar: AppBar(title: const Text('Scan to pay')),
      body: ListView(
        padding: const EdgeInsets.all(16),
        children: [
          if (camera != null)
            AspectRatio(
              aspectRatio: 1,
              child: ClipRRect(
                borderRadius: BorderRadius.circular(16),
                child: MobileScanner(
                  controller: camera,
                  onDetect: (capture) {
                    final value = capture.barcodes.firstOrNull?.rawValue;
                    if (value != null) _use(value);
                  },
                  errorBuilder: (context, error) => ColoredBox(
                    color: theme.colorScheme.surfaceContainerHighest,
                    child: Center(
                      child: Padding(
                        padding: const EdgeInsets.all(24),
                        child: Text(
                          'Camera unavailable (${error.errorCode.name}). Paste the QR text below instead.',
                          textAlign: TextAlign.center,
                        ),
                      ),
                    ),
                  ),
                ),
              ),
            ),
          const SizedBox(height: 16),
          Text('Point the camera at a PromptPay QR, or paste its text.', style: theme.textTheme.bodyMedium),
          const SizedBox(height: 12),
          TextField(
            key: const Key('qr-text'),
            controller: _text,
            minLines: 2,
            maxLines: 4,
            decoration: InputDecoration(
              labelText: 'QR text',
              border: const OutlineInputBorder(),
              errorText: _error,
              errorMaxLines: 3,
            ),
            onChanged: (_) {
              if (_error != null) setState(() => _error = null);
            },
          ),
          const SizedBox(height: 12),
          FilledButton(onPressed: () => _use(_text.text), child: const Text('Continue')),
        ],
      ),
    );
  }
}
