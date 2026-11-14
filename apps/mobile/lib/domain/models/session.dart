import 'dart:convert';

/// A signed-in user: the backend's access token and the wallet it belongs to.
class Session {
  const Session({required this.token, required this.expiresAt, required this.userId, required this.walletAddress});

  factory Session.fromJson(String source) {
    final json = jsonDecode(source) as Map<String, dynamic>;
    return Session(
      token: json['token'] as String,
      expiresAt: DateTime.parse(json['expiresAt'] as String),
      userId: json['userId'] as String,
      walletAddress: json['walletAddress'] as String,
    );
  }

  final String token;
  final DateTime expiresAt;
  final String userId;

  /// The user's wallet: a checksummed 0x address, or on the NEAR rail the implicit account id (64 hex).
  final String walletAddress;

  /// Usable for at least another minute.
  bool isValidAt(DateTime now) => now.isBefore(expiresAt.subtract(const Duration(minutes: 1)));

  String toJson() => jsonEncode({
    'token': token,
    'expiresAt': expiresAt.toIso8601String(),
    'userId': userId,
    'walletAddress': walletAddress,
  });
}
