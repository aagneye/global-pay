/// An error the UI can show, with the backend's stable error code when there is one
/// (e.g. `invalid_qr`, `not_implemented`).
class AppException implements Exception {
  const AppException(this.code, this.message);

  final String code;
  final String message;

  @override
  String toString() => 'AppException($code): $message';
}
