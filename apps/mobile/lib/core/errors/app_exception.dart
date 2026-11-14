/// An error the UI can show, with the backend's stable error code when there is one
/// (e.g. `invalid_qr`, `not_implemented`).
class AppException implements Exception {
  const AppException(this.code, this.message);

  final String code;
  final String message;

  @override
  String toString() => 'AppException($code): $message';
}

/// Whether [error] means the user backed out of the fingerprint prompt. Nothing went wrong, so screens
/// show no error for it.
bool cancelledByUser(Object error) => error is AppException && error.code == 'biometric_cancelled';
