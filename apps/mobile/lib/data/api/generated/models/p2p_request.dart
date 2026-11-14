// coverage:ignore-file
// GENERATED CODE - DO NOT MODIFY BY HAND
// ignore_for_file: type=lint, unused_import, invalid_annotation_target, unnecessary_import

import 'package:json_annotation/json_annotation.dart';

import 'p2p_recipient.dart';
import 'p2p_request_role.dart';
import 'p2p_request_status.dart';
import 'p2p_sender.dart';
import 'p2p_transaction.dart';

part 'p2p_request.g.dart';

@JsonSerializable()
class P2pRequest {
  const P2pRequest({
    required this.id,
    required this.role,
    required this.status,
    required this.token,
    required this.amount,
    required this.recipient,
    required this.expiresAt,
    required this.createdAt,
    required this.updatedAt,
    this.sender,
    this.challenge,
    this.transaction,
    this.failureReason,
  });
  
  factory P2pRequest.fromJson(Map<String, Object?> json) => _$P2pRequestFromJson(json);
  
  final String id;

  /// Your side of the request
  final P2pRequestRole role;

  /// CREATED: waiting for a tap or a scan. SENDER_IDENTIFIED: waiting for the sender to approve. SUBMITTED: transfer sent. COMPLETED and FAILED: the transfer was mined (or reverted). EXPIRED, DECLINED, CANCELLED: nothing moved.
  final P2pRequestStatus status;
  final String token;

  /// USDC base units
  final String amount;
  final P2pRecipient recipient;
  final P2pSender? sender;

  /// Receiver only, while CREATED: send it to the other phone over NFC, or show it in the QR
  final String? challenge;
  final P2pTransaction? transaction;
  final String? failureReason;
  final DateTime expiresAt;
  final DateTime createdAt;
  final DateTime updatedAt;

  Map<String, Object?> toJson() => _$P2pRequestToJson(this);
}
