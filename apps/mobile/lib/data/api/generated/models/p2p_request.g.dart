// GENERATED CODE - DO NOT MODIFY BY HAND

part of 'p2p_request.dart';

// **************************************************************************
// JsonSerializableGenerator
// **************************************************************************

P2pRequest _$P2pRequestFromJson(Map<String, dynamic> json) => P2pRequest(
  id: json['id'] as String,
  role: P2pRequestRole.fromJson(json['role'] as String),
  status: P2pRequestStatus.fromJson(json['status'] as String),
  token: json['token'] as String,
  amount: json['amount'] as String,
  recipient: P2pRecipient.fromJson(json['recipient'] as Map<String, dynamic>),
  expiresAt: DateTime.parse(json['expiresAt'] as String),
  createdAt: DateTime.parse(json['createdAt'] as String),
  updatedAt: DateTime.parse(json['updatedAt'] as String),
  sender: json['sender'] == null
      ? null
      : P2pSender.fromJson(json['sender'] as Map<String, dynamic>),
  challenge: json['challenge'] as String?,
  transaction: json['transaction'] == null
      ? null
      : P2pTransaction.fromJson(json['transaction'] as Map<String, dynamic>),
  failureReason: json['failureReason'] as String?,
);

Map<String, dynamic> _$P2pRequestToJson(P2pRequest instance) =>
    <String, dynamic>{
      'id': instance.id,
      'role': instance.role,
      'status': instance.status,
      'token': instance.token,
      'amount': instance.amount,
      'recipient': instance.recipient,
      'sender': ?instance.sender,
      'challenge': ?instance.challenge,
      'transaction': ?instance.transaction,
      'failureReason': ?instance.failureReason,
      'expiresAt': instance.expiresAt.toIso8601String(),
      'createdAt': instance.createdAt.toIso8601String(),
      'updatedAt': instance.updatedAt.toIso8601String(),
    };
