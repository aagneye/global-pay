// GENERATED CODE - DO NOT MODIFY BY HAND

part of 'p2p_incoming_list.dart';

// **************************************************************************
// JsonSerializableGenerator
// **************************************************************************

P2pIncomingList _$P2pIncomingListFromJson(Map<String, dynamic> json) =>
    P2pIncomingList(
      requests: (json['requests'] as List<dynamic>)
          .map((e) => P2pRequest.fromJson(e as Map<String, dynamic>))
          .toList(),
    );

Map<String, dynamic> _$P2pIncomingListToJson(P2pIncomingList instance) =>
    <String, dynamic>{'requests': instance.requests};
