import 'package:globalpay/core/storage/secure_store.dart';
import 'package:globalpay/domain/models/session.dart';

/// Keeps the current session in memory and in secure storage, so a restart stays signed in.
class SessionStore {
  SessionStore(this._store, {DateTime Function()? clock}) : _clock = clock ?? DateTime.now;

  static const storageKey = 'session';

  final SecureStore _store;
  final DateTime Function() _clock;
  Session? _current;

  /// The session, if there is one and it hasn't expired.
  Session? get current {
    final session = _current;
    return session != null && session.isValidAt(_clock()) ? session : null;
  }

  /// Loads the saved session. Returns null (and forgets it) if it has expired or is unreadable.
  Future<Session?> load() async {
    final saved = await _store.read(storageKey);
    if (saved == null) return null;
    try {
      _current = Session.fromJson(saved);
    } on Object {
      await clear();
      return null;
    }
    if (current == null) await clear();
    return current;
  }

  Future<void> save(Session session) async {
    _current = session;
    await _store.write(storageKey, session.toJson());
  }

  Future<void> clear() async {
    _current = null;
    await _store.delete(storageKey);
  }
}
