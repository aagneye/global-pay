// GENERATED CODE - DO NOT MODIFY BY HAND

part of 'near_payment.dart';

// **************************************************************************
// JsonSerializableGenerator
// **************************************************************************

NearPayment _$NearPaymentFromJson(Map<String, dynamic> json) => NearPayment(
  signerId: json['signerId'] as String,
  publicKey: json['publicKey'] as String,
  receiverId: json['receiverId'] as String,
  methodName: json['methodName'] as String,
  args: NearTransferCallArgs.fromJson(json['args'] as Map<String, dynamic>),
  gas: json['gas'] as String,
  deposit: json['deposit'] as String,
  nonce: json['nonce'] as String,
  maxBlockHeight: json['maxBlockHeight'] as String,
);

Map<String, dynamic> _$NearPaymentToJson(NearPayment instance) =>
    <String, dynamic>{
      'signerId': instance.signerId,
      'publicKey': instance.publicKey,
      'receiverId': instance.receiverId,
      'methodName': instance.methodName,
      'args': instance.args,
      'gas': instance.gas,
      'deposit': instance.deposit,
      'nonce': instance.nonce,
      'maxBlockHeight': instance.maxBlockHeight,
    };
