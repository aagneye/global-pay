import 'package:flutter_test/flutter_test.dart';
import 'package:globalpay/core/widgets/common.dart';
import 'package:globalpay/domain/models/money.dart';

TokenAmount usdc(int units) => TokenAmount(symbol: 'USDC', units: BigInt.from(units), decimals: 6);

void main() {
  test('groups thousands and keeps two decimals', () {
    expect(displayParts(usdc(10000000000)), (whole: '10,000', fraction: '.00'));
    expect(displayParts(usdc(1234567890123)), (whole: '1,234,567', fraction: '.89'));
    expect(displayParts(usdc(999990000)), (whole: '999', fraction: '.99'));
  });

  test('cuts instead of rounding up, so it never shows more than the wallet holds', () {
    expect(displayParts(usdc(10000129999)), (whole: '10,000', fraction: '.12'));
    expect(displayParts(usdc(9999)), (whole: '0', fraction: '.00'));
  });

  test('zero, and other precisions', () {
    expect(displayParts(usdc(0)), (whole: '0', fraction: '.00'));
    expect(displayParts(usdc(7477454), fractionDigits: 6), (whole: '7', fraction: '.477454'));
    expect(displayParts(usdc(1500000000), fractionDigits: 0), (whole: '1,500', fraction: ''));
  });
}
