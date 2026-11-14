// coverage:ignore-file
// GENERATED CODE - DO NOT MODIFY BY HAND
// ignore_for_file: type=lint, unused_import, invalid_annotation_target, unnecessary_import

import 'package:json_annotation/json_annotation.dart';

/// CREATED: waiting for a tap or a scan. SENDER_IDENTIFIED: waiting for the sender to approve. APPROVING: the sender approved and the transfer is being sent; it can no longer be cancelled. SUBMITTED: transfer sent. COMPLETED and FAILED: the transfer was mined (or reverted). EXPIRED, DECLINED, CANCELLED: nothing moved.
@JsonEnum()
enum P2pRequestStatus {
  @JsonValue('CREATED')
  created('CREATED'),
  @JsonValue('SENDER_IDENTIFIED')
  senderIdentified('SENDER_IDENTIFIED'),
  @JsonValue('APPROVING')
  approving('APPROVING'),
  @JsonValue('SUBMITTED')
  submitted('SUBMITTED'),
  @JsonValue('COMPLETED')
  completed('COMPLETED'),
  @JsonValue('FAILED')
  failed('FAILED'),
  @JsonValue('EXPIRED')
  expired('EXPIRED'),
  @JsonValue('DECLINED')
  declined('DECLINED'),
  @JsonValue('CANCELLED')
  cancelled('CANCELLED'),
  /// Default value for all unparsed values, allows backward compatibility when adding new values on the backend.
  $unknown(null);

  const P2pRequestStatus(this.json);

  factory P2pRequestStatus.fromJson(String json) => values.firstWhere(
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
  static List<P2pRequestStatus> get $valuesDefined => values.where((value) => value != $unknown).toList();
}
