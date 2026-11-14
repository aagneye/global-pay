// GENERATED CODE - DO NOT MODIFY BY HAND

part of 'near_transfer_call_args.dart';

// **************************************************************************
// JsonSerializableGenerator
// **************************************************************************

NearTransferCallArgs _$NearTransferCallArgsFromJson(
  Map<String, dynamic> json,
) => NearTransferCallArgs(
  receiverId: json['receiver_id'] as String,
  amount: json['amount'] as String,
  msg: json['msg'] as String,
);

Map<String, dynamic> _$NearTransferCallArgsToJson(
  NearTransferCallArgs instance,
) => <String, dynamic>{
  'receiver_id': instance.receiverId,
  'amount': instance.amount,
  'msg': instance.msg,
};
