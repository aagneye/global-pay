import 'dart:convert';

/// Reads borsh, to decode what the app posted independently of the app's own writer.
class BorshReader {
  BorshReader(this._bytes);

  final List<int> _bytes;
  var _offset = 0;

  bool get done => _offset == _bytes.length;

  int u8() => _bytes[_offset++];

  int u32() => _littleEndian(4).toInt();

  BigInt u64() => _littleEndian(8);

  BigInt u128() => _littleEndian(16);

  String string() => utf8.decode(bytes());

  List<int> bytes() => fixed(u32());

  List<int> fixed(int length) {
    if (_offset + length > _bytes.length) throw RangeError('read past the end');
    final value = _bytes.sublist(_offset, _offset + length);
    _offset += length;
    return value;
  }

  BigInt _littleEndian(int length) {
    var value = BigInt.zero;
    final raw = fixed(length);
    for (var i = length - 1; i >= 0; i--) {
      value = (value << 8) | BigInt.from(raw[i]);
    }
    return value;
  }
}

/// A decoded `SignedDelegate` with one `FunctionCall` action.
typedef DecodedDelegate = ({
  String senderId,
  String receiverId,
  String methodName,
  String args,
  BigInt gas,
  BigInt deposit,
  BigInt nonce,
  BigInt maxBlockHeight,
  List<int> publicKey,
  List<int> delegateBytes,
  List<int> signature,
});

/// Decodes `base64(borsh(SignedDelegate))`. Throws unless it's exactly one ed25519-signed function call.
DecodedDelegate decodeSignedDelegate(String value) {
  final bytes = base64.decode(value);
  final reader = BorshReader(bytes);
  final senderId = reader.string();
  final receiverId = reader.string();
  if (reader.u32() != 1) throw const FormatException('expected one action');
  if (reader.u8() != 2) throw const FormatException('expected a FunctionCall');
  final methodName = reader.string();
  final args = utf8.decode(reader.bytes());
  final gas = reader.u64();
  final deposit = reader.u128();
  final nonce = reader.u64();
  final maxBlockHeight = reader.u64();
  if (reader.u8() != 0) throw const FormatException('expected an ed25519 key');
  final publicKey = reader.fixed(32);
  final delegateLength = bytes.length - 65;
  if (reader.u8() != 0) throw const FormatException('expected an ed25519 signature');
  final signature = reader.fixed(64);
  if (!reader.done) throw const FormatException('trailing bytes');
  return (
    senderId: senderId,
    receiverId: receiverId,
    methodName: methodName,
    args: args,
    gas: gas,
    deposit: deposit,
    nonce: nonce,
    maxBlockHeight: maxBlockHeight,
    publicKey: publicKey,
    delegateBytes: bytes.sublist(0, delegateLength),
    signature: signature,
  );
}
