/// Money is always an integer in the currency's smallest unit (BigInt).
/// Never use `double` for amounts or rates.
library;

enum FiatCurrency {
  thb(code: 'THB', decimals: 2, symbol: '฿');

  const FiatCurrency({required this.code, required this.decimals, required this.symbol});

  final String code;
  final int decimals;
  final String symbol;
}

/// Fiat amount in minor units, e.g. THB satang (10000 = 100.00 THB).
class FiatAmount {
  const FiatAmount({required this.currency, required this.minor});

  final FiatCurrency currency;
  final BigInt minor;

  String format() => '${currency.symbol}${formatMinorUnits(minor, currency.decimals)}';
}

/// Token amount in base units, e.g. USDC with 6 decimals (1000000 = 1 USDC).
class TokenAmount {
  const TokenAmount({required this.symbol, required this.units, required this.decimals});

  final String symbol;
  final BigInt units;
  final int decimals;

  String format() => '${formatMinorUnits(units, decimals)} $symbol';
}

/// Formats integer minor units as a decimal string: (10050, 2) -> "100.50".
String formatMinorUnits(BigInt minor, int decimals) {
  final digits = minor.abs().toString().padLeft(decimals + 1, '0');
  final whole = digits.substring(0, digits.length - decimals);
  final fraction = digits.substring(digits.length - decimals);
  final sign = minor.isNegative ? '-' : '';
  return decimals == 0 ? '$sign$whole' : '$sign$whole.$fraction';
}
