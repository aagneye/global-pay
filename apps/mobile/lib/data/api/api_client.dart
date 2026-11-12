import 'package:dio/dio.dart';
import 'package:globalpay/core/config/app_config.dart';
import 'package:globalpay/core/errors/app_exception.dart';
import 'package:globalpay/data/api/generated/global_pay_api.dart';

/// HTTP access to the GlobalPay backend, through the client generated from
/// packages/openapi/openapi.json (lib/data/api/generated, see swagger_parser.yaml).
///
/// It adds the session's bearer token to every request, and turns failures into [AppException]s
/// with the backend's error code (`kyc_required`, `invalid_qr`, ...) or `network_error`.
class ApiClient {
  ApiClient(AppConfig config, {required String? Function() token, void Function()? onUnauthorized, Dio? dio})
    : dio =
          dio ??
          Dio(
            BaseOptions(
              baseUrl: config.apiBaseUrl,
              connectTimeout: const Duration(seconds: 10),
              receiveTimeout: const Duration(seconds: 30),
              // No default Content-Type: Dio sets JSON when there's a body, and the server rejects
              // an empty body labelled as JSON (e.g. POST /kyc/start).
            ),
          ) {
    this.dio.interceptors.add(
      InterceptorsWrapper(
        onRequest: (options, handler) {
          final value = token();
          if (value != null) options.headers['authorization'] = 'Bearer $value';
          handler.next(options);
        },
        onError: (error, handler) {
          if (error.response?.statusCode == 401) onUnauthorized?.call();
          handler.next(error);
        },
      ),
    );
    api = GlobalPayApi(this.dio);
  }

  final Dio dio;
  late final GlobalPayApi api;

  /// Runs an API call, turning a [DioException] into an [AppException].
  static Future<T> call<T>(Future<T> Function() request) async {
    try {
      return await request();
    } on DioException catch (e) {
      throw toAppException(e);
    }
  }

  static AppException toAppException(DioException e) {
    final data = e.response?.data;
    if (data is Map && data['error'] is String) {
      return AppException(data['error'] as String, (data['message'] as String?) ?? 'Request failed');
    }
    return switch (e.type) {
      DioExceptionType.connectionError ||
      DioExceptionType.connectionTimeout ||
      DioExceptionType.receiveTimeout ||
      DioExceptionType.sendTimeout => const AppException(
        'network_error',
        "Can't reach GlobalPay. Check your connection and try again.",
      ),
      _ => AppException('http_error', e.message ?? 'Request failed (${e.response?.statusCode})'),
    };
  }
}
