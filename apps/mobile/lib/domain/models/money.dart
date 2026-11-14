/// Money is always an integer in the currency's smallest unit (BigInt).
/// Never use `double` for amounts or rates.
library;

enum FiatCurrency {
  thb(code: 'THB', decimals: 2, symbol: '฿', name: 'baht'),
  inr(code: 'INR', decimals: 2, symbol: '₹', name: 'rupees');

  const FiatCurrency({required this.code, required this.decimals, required this.symbol, required this.name});

  final String code;
  final int decimals;
  final String symbol;

  /// The currency's name in a sentence, e.g. "Paying the merchant in rupees".
  final String name;

  /// The currency with ISO code [code] (THB or INR). Throws an [ArgumentError] for any other.
  static FiatCurrency fromCode(String code) => values.firstWhere(
    (currency) => currency.code == code,
    orElse: () => throw ArgumentError.value(code, 'code', 'Unknown fiat currency'),
  );
}

/// Fiat amount in minor units, e.g. THB satang (10000 = ฿100.00) or INR paise (25000 = ₹250.00).
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

/// A rate in fiat per USDC times 10^8 (the backend's `rateE8`), rounded to [currency]'s minor unit:
/// (8352345678, INR) -> "₹83.52".
String formatRateE8(BigInt rateE8, FiatCurrency currency) {
  final scale = BigInt.from(10).pow(8 - currency.decimals);
  return '${currency.symbol}${formatMinorUnits((rateE8 + scale ~/ BigInt.two) ~/ scale, currency.decimals)}';
}
