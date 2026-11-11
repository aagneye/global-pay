import 'package:dio/dio.dart';
import 'package:globalpay/core/config/app_config.dart';

/// HTTP access to the GlobalPay backend.
///
/// The typed client generated from the backend's OpenAPI spec lands in
/// `lib/data/api/generated/` and is wrapped by the repositories (iteration 5).
class ApiClient {
  ApiClient(AppConfig config)
      : dio = Dio(
          BaseOptions(
            baseUrl: config.apiBaseUrl,
            connectTimeout: const Duration(seconds: 10),
            receiveTimeout: const Duration(seconds: 20),
            contentType: Headers.jsonContentType,
          ),
        );

  final Dio dio;

  /// GET /health
  Future<bool> isHealthy() async {
    final response = await dio.get<Map<String, dynamic>>('/health');
    return response.data?['status'] == 'ok';
  }
}
