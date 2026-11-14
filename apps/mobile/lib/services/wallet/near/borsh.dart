import 'dart:convert';
import 'dart:typed_data';

/// Writes NEAR's borsh encoding (https://borsh.io), just the parts the wallet needs: little-endian
/// integers, strings, byte vectors and fixed arrays.
class BorshWriter {
  final _bytes = BytesBuilder(copy: false);

  static final _u64Max = (BigInt.one << 64) - BigInt.one;
  static final _u128Max = (BigInt.one << 128) - BigInt.one;

  void u8(int value) {
    _checkRange(BigInt.from(value), BigInt.from(0xff), 'u8');
    _bytes.addByte(value);
  }

  void u32(int value) {
    _checkRange(BigInt.from(value), BigInt.from(0xffffffff), 'u32');
    _bytes.add((ByteData(4)..setUint32(0, value, Endian.little)).buffer.asUint8List());
  }

  void u64(BigInt value) => _littleEndian(value, 8, _u64Max, 'u64');

  void u128(BigInt value) => _littleEndian(value, 16, _u128Max, 'u128');

  /// u32 byte length, then the UTF-8 bytes.
  void string(String value) => bytes(utf8.encode(value));

  /// `Vec<u8>`: u32 length, then the bytes.
  void bytes(List<int> value) {
    u32(value.length);
    fixedBytes(value);
  }

  /// `[u8; N]`: the bytes as they are.
  void fixedBytes(List<int> value) {
    for (final byte in value) {
      if (byte < 0 || byte > 0xff) throw ArgumentError.value(byte, 'byte', 'not a byte');
    }
    _bytes.add(value);
  }

  /// `Option<String>`: 0, or 1 and the string.
  void optionalString(String? value) {
    if (value == null) return u8(0);
    u8(1);
    string(value);
  }

  Uint8List toBytes() => _bytes.toBytes();

  void _littleEndian(BigInt value, int length, BigInt max, String type) {
    _checkRange(value, max, type);
    var rest = value;
    for (var i = 0; i < length; i++) {
      _bytes.addByte((rest & BigInt.from(0xff)).toInt());
      rest = rest >> 8;
    }
  }

  static void _checkRange(BigInt value, BigInt max, String type) {
    if (value < BigInt.zero || value > max) throw ArgumentError.value(value, type, 'out of range');
  }
}
