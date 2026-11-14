// coverage:ignore-file
// GENERATED CODE - DO NOT MODIFY BY HAND
// ignore_for_file: type=lint, unused_import, invalid_annotation_target, unnecessary_import

import 'package:json_annotation/json_annotation.dart';

/// CREATED: waiting for you to pay. PENDING: paid, USDC on its way. COMPLETED: USDC arrived in your wallet (checked on-chain). FAILED: the purchase failed. EXPIRED: not paid in time.
@JsonEnum()
enum OnrampOrderStatus {
  @JsonValue('CREATED')
  created('CREATED'),
  @JsonValue('PENDING')
  pending('PENDING'),
  @JsonValue('COMPLETED')
  completed('COMPLETED'),
  @JsonValue('FAILED')
  failed('FAILED'),
  @JsonValue('EXPIRED')
  expired('EXPIRED'),
  /// Default value for all unparsed values, allows backward compatibility when adding new values on the backend.
  $unknown(null);

  const OnrampOrderStatus(this.json);

  factory OnrampOrderStatus.fromJson(String json) => values.firstWhere(
        (e) => e.json == json,
        orElse: () => $unknown,
      );

  final String? json;
  String toJson() {
    final value = json;
    if (value == null) {
      throw StateError('Cannot convert enum value with null JSON representation to String. '
          'This usually happens for \$unknown or @JsonValue(null) entries.');
    }
    return value as String;
  }

  @override
  String toString() => json?.toString() ?? super.toString();
  /// Returns all defined enum values excluding the $unknown value.
  static List<OnrampOrderStatus> get $valuesDefined => values.where((value) => value != $unknown).toList();
}
