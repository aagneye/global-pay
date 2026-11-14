/// Reads a stable identifier (the application PAN) from a contactless EMV bank card, so the card can act as a
/// physical key for the wallet. Many bank cards randomise their NFC UID on every tap, but the PAN stays the same.
///
/// The flow is the start of a normal contactless payment, stopped before anything is authorised:
///
///   1. SELECT "2PAY.SYS.DDF01" (PPSE)      → the card's application IDs (tag 4F, ordered by 87)
///      falls back to SELECT "1PAY.SYS.DDF01" (PSE) once, reading its directory records
///   2. SELECT the AID                       → FCI, maybe with a PDOL (9F38)
///   3. GET PROCESSING OPTIONS (PDOL data)   → 77 template (94 AFL, maybe 57/5A) or 80 (AIP ‖ AFL)
///   4. READ RECORD for every AFL entry      → until a 5A (PAN) or 57 (track 2 equivalent) turns up
///
/// No cryptogram is requested and nothing is signed or charged. The NFC session, hashing and storage live
/// elsewhere: this file only needs a [Transceive] callback, so it is pure Dart and fully unit-testable.
///
/// Privacy: the PAN is never printed or logged here, and neither [EmvCardId.toString] nor [Tlv.toString] shows it.
library;

import 'dart:math';
import 'dart:typed_data';

/// Sends one command APDU to the card and returns the full response, status word (SW1 SW2) included.
typedef Transceive = Future<Uint8List> Function(Uint8List command);

/// The identifier read from a card. Callers should hash [pan] straight away and keep only [last4] for display.
class EmvCardId {
  EmvCardId(this.pan) : last4 = pan.length > 4 ? pan.substring(pan.length - 4) : pan;

  final String pan;
  final String last4;

  @override
  String toString() => 'EmvCardId(•••• $last4)';
}

/// One BER-TLV data object. [children] holds the parsed contents of a constructed object (empty otherwise).
class Tlv {
  const Tlv(this.tag, this.value, [this.children = const []]);

  /// The tag bytes as one big-endian number, e.g. 0x5A, 0x9F38, 0xBF0C.
  final int tag;
  final Uint8List value;
  final List<Tlv> children;

  /// Never shows the value: it may be a PAN or track 2.
  @override
  String toString() => 'Tlv(${tag.toRadixString(16).toUpperCase()}, ${value.length} bytes)';
}

/// Parses BER-TLV data: multi-byte tags, 0x81/0x82/0x83 lengths, constructed objects parsed recursively. Skips the
/// 0x00/0xFF padding EMV allows between and after objects. Never throws: on malformed input it returns whatever
/// parsed cleanly before the problem.
List<Tlv> parseTlv(Uint8List data) {
  final out = <Tlv>[];
  var i = 0;
  while (i < data.length) {
    if (data[i] == 0x00 || data[i] == 0xFF) {
      i++;
      continue;
    }
    final first = data[i];
    final tagRead = _readTag(data, i);
    if (tagRead == null) break;
    i = tagRead.next;
    if (i >= data.length) break;

    var length = data[i++];
    if (length & 0x80 != 0) {
      final count = length & 0x7F;
      if (count == 0 || count > 3 || i + count > data.length) break;
      length = 0;
      for (var k = 0; k < count; k++) {
        length = (length << 8) | data[i++];
      }
    }
    if (i + length > data.length) break;

    final value = data.sublist(i, i + length);
    i += length;
    final constructed = first & 0x20 != 0;
    out.add(Tlv(tagRead.tag, value, constructed ? parseTlv(value) : const []));
  }
  return out;
}

/// Depth-first search for the first object with [tag], looking inside constructed objects too.
Tlv? findTag(List<Tlv> tlvs, int tag) {
  for (final tlv in tlvs) {
    if (tlv.tag == tag) return tlv;
    final inner = findTag(tlv.children, tag);
    if (inner != null) return inner;
  }
  return null;
}

/// Reads the card's PAN. Returns null (never throws) for non-EMV cards, cards that don't reveal a PAN, and any
/// transceive error, so the caller can fall back to the tag UID. [now] and [random] are only for tests.
Future<EmvCardId?> readEmvCard(Transceive transceive, {DateTime? now, Random? random}) async {
  try {
    final aids = await _findAids(transceive);
    final scan = _PanScan();
    for (final aid in aids) {
      await _readApplication(transceive, aid, scan, now ?? DateTime.now(), random ?? _secureRandom());
      if (scan.luhnValid != null) break;
    }
    final pan = scan.result;
    return pan == null ? null : EmvCardId(pan);
  } catch (_) {
    return null;
  }
}

// --- Commands --------------------------------------------------------------------------------------------------

const _ok = 0x9000;

/// "2PAY.SYS.DDF01": the contactless directory.
final _ppse = Uint8List.fromList('2PAY.SYS.DDF01'.codeUnits);

/// "1PAY.SYS.DDF01": the contact directory, which some cards also answer over NFC.
final _pse = Uint8List.fromList('1PAY.SYS.DDF01'.codeUnits);

/// Every command below ends with Le = 00 ("send what you have"), so a 6C xx retry only swaps the last byte.
Uint8List _select(Uint8List name) => Uint8List.fromList([0x00, 0xA4, 0x04, 0x00, name.length, ...name, 0x00]);

Uint8List _readRecord(int sfi, int record) => Uint8List.fromList([0x00, 0xB2, record, (sfi << 3) | 0x04, 0x00]);

Uint8List? _getProcessingOptions(Uint8List pdolData) {
  final template = [0x83, ..._berLength(pdolData.length), ...pdolData];
  if (template.length > 0xFF) return null;
  return Uint8List.fromList([0x80, 0xA8, 0x00, 0x00, template.length, ...template, 0x00]);
}

List<int> _berLength(int length) {
  if (length < 0x80) return [length];
  if (length <= 0xFF) return [0x81, length];
  return [0x82, length >> 8, length & 0xFF];
}

/// Sends [command] and follows the ISO 7816-4 transport status words: 6C xx (wrong Le) resends the same command
/// with Le = xx; 61 xx (more data) asks for it with GET RESPONSE. Returns the collected data and the final status.
Future<({Uint8List data, int sw})> _exchange(Transceive transceive, Uint8List command) async {
  final data = BytesBuilder(copy: false);
  var next = command;
  for (var hop = 0; hop < 16; hop++) {
    final response = await transceive(next);
    if (response.length < 2) break;
    final sw1 = response[response.length - 2];
    final sw2 = response[response.length - 1];
    if (sw1 == 0x6C) {
      next = Uint8List.fromList([...next.sublist(0, next.length - 1), sw2]);
      continue;
    }
    data.add(response.sublist(0, response.length - 2));
    if (sw1 == 0x61) {
      next = Uint8List.fromList([0x00, 0xC0, 0x00, 0x00, sw2]);
      continue;
    }
    return (data: data.takeBytes(), sw: (sw1 << 8) | sw2);
  }
  return (data: Uint8List(0), sw: -1);
}

// --- Application selection -------------------------------------------------------------------------------------

/// The card's AIDs in the order to try them: PPSE first, PSE once if PPSE gives nothing.
Future<List<Uint8List>> _findAids(Transceive transceive) async {
  final ppse = await _exchange(transceive, _select(_ppse));
  if (ppse.sw == _ok) {
    final aids = _aidsFrom(parseTlv(ppse.data));
    if (aids.isNotEmpty) return aids;
  }

  final pse = await _exchange(transceive, _select(_pse));
  if (pse.sw != _ok) return const [];
  final fci = parseTlv(pse.data);
  final direct = _aidsFrom(fci);
  if (direct.isNotEmpty) return direct;

  // A contact-style PSE names a directory file (tag 88) whose records list the applications.
  final sfi = findTag(fci, 0x88);
  if (sfi == null || sfi.value.isEmpty) return const [];
  final entries = <Tlv>[];
  for (var record = 1; record <= 16; record++) {
    final read = await _exchange(transceive, _readRecord(sfi.value.first & 0x1F, record));
    if (read.sw != _ok) break;
    entries.addAll(parseTlv(read.data));
  }
  return _aidsFrom(entries);
}

/// AIDs (4F) from the directory entries (61), highest priority (87, 1 = highest) first, entries without a
/// priority after those with one, and directory order kept otherwise.
List<Uint8List> _aidsFrom(List<Tlv> tlvs) {
  final entries = <({Uint8List aid, int priority, int index})>[];
  for (final entry in _findAll(tlvs, 0x61)) {
    final aid = findTag(entry.children, 0x4F);
    if (aid == null || aid.value.isEmpty) continue;
    final priority = findTag(entry.children, 0x87)?.value;
    final rank = priority == null || priority.isEmpty || priority.first & 0x0F == 0 ? 16 : priority.first & 0x0F;
    entries.add((aid: aid.value, priority: rank, index: entries.length));
  }
  if (entries.isEmpty) {
    return [
      for (final aid in _findAll(tlvs, 0x4F))
        if (aid.value.isNotEmpty) aid.value,
    ];
  }
  entries.sort((a, b) => a.priority != b.priority ? a.priority - b.priority : a.index - b.index);
  return [for (final entry in entries) entry.aid];
}

List<Tlv> _findAll(List<Tlv> tlvs, int tag) => [
  for (final tlv in tlvs) ...[if (tlv.tag == tag) tlv, ..._findAll(tlv.children, tag)],
];

// --- Reading one application -----------------------------------------------------------------------------------

Future<void> _readApplication(Transceive transceive, Uint8List aid, _PanScan scan, DateTime now, Random random) async {
  final select = await _exchange(transceive, _select(aid));
  if (select.sw != _ok) return;

  final pdol = findTag(parseTlv(select.data), 0x9F38);
  final gpoCommand = _getProcessingOptions(pdol == null ? Uint8List(0) : _pdolData(pdol.value, now, random));
  if (gpoCommand == null) return;
  final gpo = await _exchange(transceive, gpoCommand);
  if (gpo.sw != _ok) return;

  final gpoTlvs = parseTlv(gpo.data);
  if (scan.offer(gpoTlvs)) return;

  final afl = _afl(gpoTlvs);
  for (var i = 0; i + 4 <= afl.length; i += 4) {
    final sfi = afl[i] >> 3;
    if (sfi < 1 || sfi > 30) continue;
    for (var record = max(1, afl[i + 1]); record <= afl[i + 2]; record++) {
      final read = await _exchange(transceive, _readRecord(sfi, record));
      if (read.sw == _ok && scan.offer(parseTlv(read.data))) return;
    }
  }
}

/// The Application File Locator: format 1 (80 = AIP ‖ AFL) or format 2 (77 template with 94).
Uint8List _afl(List<Tlv> gpo) {
  for (final tlv in gpo) {
    if (tlv.tag == 0x80) return tlv.value.length > 2 ? tlv.value.sublist(2) : Uint8List(0);
  }
  return findTag(gpo, 0x94)?.value ?? Uint8List(0);
}

/// Terminal Transaction Qualifiers (9F66), a common value among contactless readers:
///   byte 1 0x36: EMV mode (qVSDC), EMV contact chip, online PIN and signature supported;
///   byte 2 0x00: no online cryptogram or CVM required;
///   byte 3 0x40: consumer device CVM supported (phone wallets answer too);
///   byte 4 0x00.
/// EMV mode makes Visa-style cards answer GPO with track 2 / an AFL; we never go on to ask for a cryptogram.
const _ttq = [0x36, 0x00, 0x40, 0x00];

/// Data objects with numeric (n) format: padded and truncated on the left, binary ones on the right.
const _numericTags = {0x9F02, 0x9F03, 0x9F1A, 0x5F2A, 0x9A, 0x9C};

/// Builds the data the card asked for in its PDOL (a list of tag + length, no values).
Uint8List _pdolData(Uint8List dol, DateTime now, Random random) {
  final out = BytesBuilder();
  var i = 0;
  while (i < dol.length) {
    final tagRead = _readTag(dol, i);
    if (tagRead == null || tagRead.next >= dol.length) break;
    final length = dol[tagRead.next];
    i = tagRead.next + 1;
    out.add(_fit(_terminalValue(tagRead.tag, length, now, random), length, _numericTags.contains(tagRead.tag)));
  }
  return out.takeBytes();
}

List<int> _terminalValue(int tag, int length, DateTime now, Random random) => switch (tag) {
  0x9F66 => _ttq,
  0x9F02 || 0x9F03 => List.filled(6, 0), // amount authorised / other: zero
  0x9F1A || 0x5F2A => const [0x03, 0x56], // terminal country / transaction currency: 356
  0x9A => [_bcd(now.year % 100), _bcd(now.month), _bcd(now.day)], // transaction date, YYMMDD
  0x9C => const [0x00], // transaction type: purchase
  0x9F35 => const [0x22], // terminal type: attended, offline with online capability
  0x9F37 => List.generate(length, (_) => random.nextInt(256)), // unpredictable number
  0x95 => List.filled(5, 0), // terminal verification results
  _ => const [], // anything else: zeros
};

int _bcd(int value) => ((value ~/ 10) << 4) | (value % 10);

List<int> _fit(List<int> value, int length, bool numeric) {
  if (value.length == length) return value;
  if (value.length > length) {
    return numeric ? value.sublist(value.length - length) : value.sublist(0, length);
  }
  final padding = List.filled(length - value.length, 0);
  return numeric ? [...padding, ...value] : [...value, ...padding];
}

// --- Finding the PAN -------------------------------------------------------------------------------------------

/// Keeps reading until a PAN that passes the Luhn check turns up; remembers the first well-formed one in case
/// none does (an identifier only has to be stable, so it is still better than the UID).
class _PanScan {
  String? luhnValid;
  String? firstSeen;

  String? get result => luhnValid ?? firstSeen;

  /// True once a Luhn-valid PAN is found.
  bool offer(List<Tlv> tlvs) {
    final pan = _panFrom(tlvs);
    if (pan == null) return false;
    if (_luhn(pan)) {
      luhnValid = pan;
      return true;
    }
    firstSeen ??= pan;
    return false;
  }
}

String? _panFrom(List<Tlv> tlvs) {
  final pan = findTag(tlvs, 0x5A);
  if (pan != null) {
    final digits = _validPan(_hex(pan.value).replaceFirst(RegExp(r'F+$'), ''));
    if (digits != null) return digits;
  }
  // Track 2 equivalent (57) or Mastercard's magstripe track 2 (9F6B): PAN, 'D' separator, expiry, ...
  for (final tag in const [0x57, 0x9F6B]) {
    final track2 = findTag(tlvs, tag);
    if (track2 == null) continue;
    final hex = _hex(track2.value);
    final separator = hex.indexOf('D');
    if (separator <= 0) continue;
    final digits = _validPan(hex.substring(0, separator));
    if (digits != null) return digits;
  }
  return null;
}

final _panPattern = RegExp(r'^[0-9]{12,19}$');

String? _validPan(String digits) => _panPattern.hasMatch(digits) ? digits : null;

bool _luhn(String digits) {
  var sum = 0;
  for (var i = 0; i < digits.length; i++) {
    var digit = digits.codeUnitAt(digits.length - 1 - i) - 0x30;
    if (i.isOdd) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
  }
  return sum % 10 == 0;
}

// --- Helpers ---------------------------------------------------------------------------------------------------

/// Reads a BER tag starting at [start]: one byte, or more when the low five bits are all set (each following
/// byte has bit 8 set while more follow). Null when the tag runs off the end or is longer than four bytes.
({int tag, int next})? _readTag(Uint8List data, int start) {
  var i = start;
  var tag = data[i++];
  if (tag & 0x1F == 0x1F) {
    while (true) {
      if (i >= data.length || i - start >= 4) return null;
      final byte = data[i++];
      tag = (tag << 8) | byte;
      if (byte & 0x80 == 0) break;
    }
  }
  return (tag: tag, next: i);
}

String _hex(Uint8List bytes) => [for (final byte in bytes) byte.toRadixString(16).padLeft(2, '0')].join().toUpperCase();

Random _secureRandom() {
  try {
    return Random.secure();
  } catch (_) {
    return Random();
  }
}
