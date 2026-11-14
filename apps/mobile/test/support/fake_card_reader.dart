import 'package:globalpay/services/card_key/card_reader.dart';

/// A card reader without NFC hardware. [available] false: like the emulator (the app offers the demo card).
/// Otherwise each [read] answers with [card], like a card tapped on the phone.
class FakeCardReader implements CardReader {
  FakeCardReader({this.available = false, this.card});

  final bool available;
  CardTap? card;
  int reads = 0;

  @override
  Future<bool> isAvailable() async => available;

  @override
  Future<CardTap> read() async {
    reads++;
    return card ?? (throw StateError('No card to tap'));
  }

  @override
  Future<void> stop() async {}
}
