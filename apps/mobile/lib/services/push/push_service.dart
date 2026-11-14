import 'dart:async';

import 'package:firebase_core/firebase_core.dart';
import 'package:firebase_messaging/firebase_messaging.dart';

/// Push notifications. The backend sends only a request ID (ADR 0010); the app fetches the rest.
abstract interface class PushService {
  /// Sets push up (asks for permission on Android 13+). False when push isn't configured.
  Future<bool> start();

  /// This install's push token, for POST /devices.
  Future<String?> token();

  /// Request IDs to open: from a notification the user tapped, or one that arrived while the app is open.
  Stream<String> get requestIds;
}

/// Firebase options from `--dart-define`s (no google-services.json needed):
/// FIREBASE_API_KEY, FIREBASE_APP_ID, FIREBASE_SENDER_ID, FIREBASE_PROJECT_ID.
class FirebaseConfig {
  const FirebaseConfig({required this.apiKey, required this.appId, required this.senderId, required this.projectId});

  factory FirebaseConfig.fromEnvironment() => const FirebaseConfig(
    apiKey: String.fromEnvironment('FIREBASE_API_KEY'),
    appId: String.fromEnvironment('FIREBASE_APP_ID'),
    senderId: String.fromEnvironment('FIREBASE_SENDER_ID'),
    projectId: String.fromEnvironment('FIREBASE_PROJECT_ID'),
  );

  final String apiKey;
  final String appId;
  final String senderId;
  final String projectId;

  bool get isConfigured => apiKey.isNotEmpty && appId.isNotEmpty && senderId.isNotEmpty && projectId.isNotEmpty;
}

class FirebasePushService implements PushService {
  FirebasePushService(this.config);

  final FirebaseConfig config;
  final _ids = StreamController<String>.broadcast();
  bool _started = false;
  String? _token;

  @override
  Stream<String> get requestIds => _ids.stream;

  @override
  Future<bool> start() async {
    if (!config.isConfigured) return false;
    if (_started) return true;
    await Firebase.initializeApp(
      options: FirebaseOptions(apiKey: config.apiKey, appId: config.appId, messagingSenderId: config.senderId, projectId: config.projectId),
    );
    final messaging = FirebaseMessaging.instance;
    await messaging.requestPermission();
    void emit(RemoteMessage message) {
      final id = message.data['requestId'];
      if (message.data['type'] == 'p2p_request' && id is String) _ids.add(id);
    }

    // Registration gives the token (and a new one whenever FCM rotates it).
    final registered = messaging.onRegistered.first;
    messaging.onRegistered.listen((token) => _token = token);
    await messaging.register();
    _token = await registered.timeout(const Duration(seconds: 10), onTimeout: () => '');
    FirebaseMessaging.onMessage.listen(emit);
    FirebaseMessaging.onMessageOpenedApp.listen(emit);
    final initial = await messaging.getInitialMessage();
    if (initial != null) emit(initial);
    _started = true;
    return true;
  }

  @override
  Future<String?> token() async => (_token?.isEmpty ?? true) ? null : _token;
}

/// Push not configured: the sender's "Pay by tap" screen polls for requests instead.
class NoPushService implements PushService {
  const NoPushService();

  @override
  Future<bool> start() async => false;

  @override
  Future<String?> token() async => null;

  @override
  Stream<String> get requestIds => const Stream.empty();
}
