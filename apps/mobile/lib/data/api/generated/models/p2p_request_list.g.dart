// GENERATED CODE - DO NOT MODIFY BY HAND

part of 'p2p_request_list.dart';

// **************************************************************************
// JsonSerializableGenerator
// **************************************************************************

P2pRequestList _$P2pRequestListFromJson(Map<String, dynamic> json) =>
    P2pRequestList(
      requests: (json['requests'] as List<dynamic>)
          .map((e) => P2pRequest.fromJson(e as Map<String, dynamic>))
          .toList(),
    );

Map<String, dynamic> _$P2pRequestListToJson(P2pRequestList instance) =>
    <String, dynamic>{'requests': instance.requests};
