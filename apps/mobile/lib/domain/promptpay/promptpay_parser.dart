import 'dart:convert';

import 'package:globalpay/domain/models/money.dart';
import 'package:globalpay/domain/models/promptpay_qr.dart';

/// Error codes shared with packages/fixtures/promptpay/vectors.json.
enum PromptPayError {
  missingCrc('missing_crc'),
  crcMismatch('crc_mismatch'),
  malformedTlv('malformed_tlv'),
  notPromptPay('not_promptpay'),
  unsupportedCurrency('unsupported_currency'),
  invalidField('invalid_field');

  const PromptPayError(this.code);

  /// The code used in the shared fixtures and by the backend.
  final String code;
}

class PromptPayParseException implements Exception {
  const PromptPayParseException(this.error, this.message);

  final PromptPayError error;
  final String message;

  @override
  String toString() => 'PromptPayParseException(${error.code}): $message';
}

const _personalAid = 'A000000677010111';
const _merchantAid = 'A000000677010112';
const _personalTargetTags = {
  PromptPayTargetType.mobile: '01',
  PromptPayTargetType.nationalId: '02',
  PromptPayTargetType.eWallet: '03',
};
const _targetIdLength = {
  PromptPayTargetType.mobile: 13,
  PromptPayTargetType.nationalId: 13,
  PromptPayTargetType.eWallet: 15,
  PromptPayTargetType.biller: 15,
};
final _digits = RegExp(r'^\d+$');
final _twoDigits = RegExp(r'^\d{2}$');
final _amount = RegExp(r'^(\d+)(?:\.(\d{1,2}))?$');

/// Parses and validates an EMVCo PromptPay payload, the same way as the backend
/// (services/api/src/lib/promptpay/parse.ts).
///
/// Checks run in the order documented in packages/fixtures/README.md, so each bad payload gets one error:
/// CRC present and valid -> TLV well formed -> PromptPay tag 29/30 -> currency THB (764) -> field values.
/// The backend checks every QR again, so this is for instant feedback in the app.
PromptPayQr parsePromptPayQr(String input) {
  final payload = input.trim();

  // 1. CRC: the payload ends with "6304" + 4 hex digits, computed over everything before them.
  if (payload.length < 8 || payload.substring(payload.length - 8, payload.length - 4) != '6304') {
    throw const PromptPayParseException(PromptPayError.missingCrc, 'QR has no checksum');
  }
  final body = payload.substring(0, payload.length - 4);
  if (payload.substring(payload.length - 4).toUpperCase() != crc16(body)) {
    throw const PromptPayParseException(PromptPayError.crcMismatch, 'QR checksum does not match');
  }

  // 2. TLV structure, with the CRC as the last field.
  final fields = parseTlv(payload);
  if (fields == null || fields.last.tag != '63') {
    throw const PromptPayParseException(PromptPayError.malformedTlv, 'QR fields are malformed');
  }
  final top = {for (final field in fields) field.tag: field.value};
  final personal = top['29'] == null ? null : parseTlv(top['29']!);
  final merchant = top['30'] == null ? null : parseTlv(top['30']!);
  if ((top['29'] != null && personal == null) || (top['30'] != null && merchant == null)) {
    throw const PromptPayParseException(PromptPayError.malformedTlv, 'QR payee fields are malformed');
  }

  // 3. PromptPay, in THB.
  final personalMap = personal == null ? null : {for (final f in personal) f.tag: f.value};
  final merchantMap = merchant == null ? null : {for (final f in merchant) f.tag: f.value};
  final isPersonal = personalMap?['00'] == _personalAid;
  final isMerchant = merchantMap?['00'] == _merchantAid;
  if (!isPersonal && !isMerchant) {
    throw const PromptPayParseException(PromptPayError.notPromptPay, 'Not a PromptPay QR');
  }
  if (top['53'] != '764') {
    throw const PromptPayParseException(PromptPayError.unsupportedCurrency, 'Only Thai baht (THB) QRs are supported');
  }

  // 4. Field values.
  if (isPersonal && isMerchant) _invalid('QR names both a personal and a merchant payee');
  if (top['00'] != '01') _invalid('Unknown QR payload format');
  if (top['58'] != 'TH') _invalid('QR country must be TH');
  final amount = _parseAmount(top['54']);
  final isDynamic = switch (top['01']) {
    null => amount != null,
    '11' => false,
    '12' => true,
    _ => _invalid('Unknown QR initiation method'),
  };

  if (isMerchant) {
    final targetId = merchantMap!['01'];
    if (targetId == null || !_isValidTargetId(PromptPayTargetType.biller, targetId)) {
      _invalid('Invalid biller ID');
    }
    return PromptPayQr(
      raw: payload,
      isDynamic: isDynamic,
      kind: PromptPayKind.merchant,
      targetType: PromptPayTargetType.biller,
      targetId: targetId,
      reference1: merchantMap['02'],
      reference2: merchantMap['03'],
      amount: amount,
      merchantName: top['59'],
      merchantCity: top['60'],
    );
  }

  final targets = [
    for (final MapEntry(key: type, value: tag) in _personalTargetTags.entries)
      if (personalMap![tag] != null) (type, personalMap[tag]!),
  ];
  if (targets.length != 1) _invalid('QR must name exactly one payee');
  final (targetType, targetId) = targets.single;
  if (!_isValidTargetId(targetType, targetId)) _invalid('Invalid ${targetType.name} ID');
  return PromptPayQr(
    raw: payload,
    isDynamic: isDynamic,
    kind: PromptPayKind.personal,
    targetType: targetType,
    targetId: targetId,
    amount: amount,
    merchantName: top['59'],
    merchantCity: top['60'],
  );
}

Never _invalid(String message) => throw PromptPayParseException(PromptPayError.invalidField, message);

bool _isValidTargetId(PromptPayTargetType type, String id) =>
    _digits.hasMatch(id) && id.length == _targetIdLength[type];

/// Tag 54: a positive decimal with at most 2 fraction digits ("100", "59.5", "250.00").
FiatAmount? _parseAmount(String? value) {
  if (value == null) return null;
  final match = _amount.firstMatch(value);
  if (match == null) _invalid('Invalid QR amount');
  final minor = BigInt.parse(match.group(1)! + (match.group(2) ?? '').padRight(2, '0'));
  if (minor <= BigInt.zero) _invalid('Invalid QR amount');
  return FiatAmount(currency: FiatCurrency.thb, minor: minor);
}

/// One EMVCo field: a 2-digit tag and its value.
class TlvField {
  const TlvField(this.tag, this.value);

  final String tag;
  final String value;
}

/// Splits a payload into fields. Returns null if it's malformed: a tag or length that isn't two digits,
/// a zero length, a value running past the end, or a repeated tag. Lengths count characters.
List<TlvField>? parseTlv(String data) {
  final chars = data.runes.map(String.fromCharCode).toList();
  final fields = <TlvField>[];
  final seen = <String>{};
  var i = 0;
  while (i < chars.length) {
    if (i + 4 > chars.length) return null;
    final tag = chars.sublist(i, i + 2).join();
    final lengthText = chars.sublist(i + 2, i + 4).join();
    if (!_twoDigits.hasMatch(tag) || !_twoDigits.hasMatch(lengthText)) return null;
    final length = int.parse(lengthText);
    if (length == 0 || i + 4 + length > chars.length || !seen.add(tag)) return null;
    fields.add(TlvField(tag, chars.sublist(i + 4, i + 4 + length).join()));
    i += 4 + length;
  }
  return fields;
}

/// CRC-16/CCITT-FALSE (poly 0x1021, init 0xFFFF) over the UTF-8 bytes of [data], as 4 uppercase hex digits.
String crc16(String data) {
  var crc = 0xFFFF;
  for (final byte in utf8.encode(data)) {
    crc ^= byte << 8;
    for (var bit = 0; bit < 8; bit++) {
      crc = (crc & 0x8000) != 0 ? ((crc << 1) ^ 0x1021) & 0xFFFF : (crc << 1) & 0xFFFF;
    }
  }
  return crc.toRadixString(16).toUpperCase().padLeft(4, '0');
}
