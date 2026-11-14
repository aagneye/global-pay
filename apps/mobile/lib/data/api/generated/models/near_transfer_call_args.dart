// coverage:ignore-file
// GENERATED CODE - DO NOT MODIFY BY HAND
// ignore_for_file: type=lint, unused_import, invalid_annotation_target, unnecessary_import

import 'package:json_annotation/json_annotation.dart';

part 'near_transfer_call_args.g.dart';

/// The `ft_transfer_call` arguments, as JSON
@JsonSerializable()
class NearTransferCallArgs {
  const NearTransferCallArgs({
    required this.receiverId,
    required this.amount,
    required this.msg,
  });
  
  factory NearTransferCallArgs.fromJson(Map<String, Object?> json) => _$NearTransferCallArgsFromJson(json);
  
  /// The settlement contract
  @JsonKey(name: 'receiver_id')
  final String receiverId;

  /// USDC base units: the quote tokenAmount
  final String amount;

  /// JSON {"quote": <quote JSON>, "signature": <base64 ed25519>} that the settlement contract checks
  final String msg;

  Map<String, Object?> toJson() => _$NearTransferCallArgsToJson(this);
}
