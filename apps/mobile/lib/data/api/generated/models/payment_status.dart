// coverage:ignore-file
// GENERATED CODE - DO NOT MODIFY BY HAND
// ignore_for_file: type=lint, unused_import, invalid_annotation_target, unnecessary_import

import 'package:json_annotation/json_annotation.dart';

/// SETTLED, REFUNDED and FAILED are final. Poll until one of them.
@JsonEnum()
enum PaymentStatus {
  @JsonValue('SUBMITTED')
  submitted('SUBMITTED'),
  @JsonValue('PAID')
  paid('PAID'),
  @JsonValue('PAYOUT_PENDING')
  payoutPending('PAYOUT_PENDING'),
  @JsonValue('SETTLED')
  settled('SETTLED'),
  @JsonValue('REFUNDED')
  refunded('REFUNDED'),
  @JsonValue('FAILED')
  failed('FAILED'),
  /// Default value for all unparsed values, allows backward compatibility when adding new values on the backend.
  $unknown(null);

  const PaymentStatus(this.json);

  factory PaymentStatus.fromJson(String json) => values.firstWhere(
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
  static List<PaymentStatus> get $valuesDefined => values.where((value) => value != $unknown).toList();
}
