import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

/// The palette: black on white, greys for structure, and yellow as a rare accent (the wordmark's dot,
/// small tags, the scan icon). Keep yellow to a few small marks per screen.
abstract final class Brand {
  static const ink = Color(0xFF0A0A0A);
  static const paper = Color(0xFFFFFFFF);

  /// Fills for tiles, inputs and quiet surfaces.
  static const mist = Color(0xFFF4F4F4);

  /// Hairlines and borders.
  static const line = Color(0xFFE6E6E6);

  /// Secondary text.
  static const muted = Color(0xFF6E6E6E);

  static const accent = Color(0xFFFFD60A);

  /// Accent-toned text that stays readable on white (pending states).
  static const accentInk = Color(0xFF8A6A00);

  static const danger = Color(0xFFC62828);
}

ThemeData buildTheme(Brightness brightness) {
  const scheme = ColorScheme(
    brightness: Brightness.light,
    primary: Brand.ink,
    onPrimary: Brand.paper,
    primaryContainer: Brand.mist,
    onPrimaryContainer: Brand.ink,
    secondary: Brand.ink,
    onSecondary: Brand.paper,
    secondaryContainer: Brand.mist,
    onSecondaryContainer: Brand.ink,
    tertiary: Brand.accentInk,
    onTertiary: Brand.paper,
    tertiaryContainer: Brand.accent,
    onTertiaryContainer: Brand.ink,
    error: Brand.danger,
    onError: Brand.paper,
    surface: Brand.paper,
    onSurface: Brand.ink,
    onSurfaceVariant: Brand.muted,
    surfaceContainerLowest: Brand.paper,
    surfaceContainerLow: Color(0xFFFAFAFA),
    surfaceContainer: Brand.mist,
    surfaceContainerHigh: Color(0xFFEFEFEF),
    surfaceContainerHighest: Color(0xFFEAEAEA),
    outline: Color(0xFFA0A0A0),
    outlineVariant: Brand.line,
    inverseSurface: Brand.ink,
    onInverseSurface: Brand.paper,
    inversePrimary: Brand.accent,
    surfaceTint: Colors.transparent,
    shadow: Colors.black,
    scrim: Colors.black,
  );

  final base = ThemeData(colorScheme: scheme, useMaterial3: true);
  final text = base.textTheme.apply(bodyColor: Brand.ink, displayColor: Brand.ink);
  final textTheme = text.copyWith(
    displayLarge: text.displayLarge?.copyWith(fontWeight: FontWeight.w600, letterSpacing: -1.5),
    displayMedium: text.displayMedium?.copyWith(fontWeight: FontWeight.w600, letterSpacing: -1.2),
    displaySmall: text.displaySmall?.copyWith(fontWeight: FontWeight.w600, letterSpacing: -1),
    headlineLarge: text.headlineLarge?.copyWith(fontWeight: FontWeight.w600, letterSpacing: -0.8),
    headlineMedium: text.headlineMedium?.copyWith(fontWeight: FontWeight.w600, letterSpacing: -0.6),
    headlineSmall: text.headlineSmall?.copyWith(fontWeight: FontWeight.w600, letterSpacing: -0.4),
    titleLarge: text.titleLarge?.copyWith(fontWeight: FontWeight.w600, letterSpacing: -0.2),
    titleMedium: text.titleMedium?.copyWith(fontWeight: FontWeight.w600),
    titleSmall: text.titleSmall?.copyWith(fontWeight: FontWeight.w600),
    bodyLarge: text.bodyLarge?.copyWith(height: 1.45, letterSpacing: 0.1),
    bodyMedium: text.bodyMedium?.copyWith(height: 1.45, letterSpacing: 0.1),
    bodySmall: text.bodySmall?.copyWith(color: Brand.muted, height: 1.4, letterSpacing: 0.1),
    labelMedium: text.labelMedium?.copyWith(letterSpacing: 0.1),
    labelLarge: text.labelLarge?.copyWith(fontWeight: FontWeight.w600, letterSpacing: 0.1),
    labelSmall: text.labelSmall?.copyWith(fontWeight: FontWeight.w600, letterSpacing: 0.6),
  );

  const radius = BorderRadius.all(Radius.circular(16));
  const buttonShape = RoundedRectangleBorder(borderRadius: radius);
  const buttonSize = Size(64, 56);
  final buttonText = textTheme.labelLarge?.copyWith(fontSize: 16);

  return base.copyWith(
    scaffoldBackgroundColor: Brand.paper,
    textTheme: textTheme,
    appBarTheme: AppBarTheme(
      backgroundColor: Brand.paper,
      foregroundColor: Brand.ink,
      elevation: 0,
      scrolledUnderElevation: 0,
      surfaceTintColor: Colors.transparent,
      centerTitle: false,
      titleTextStyle: textTheme.titleLarge,
      systemOverlayStyle: SystemUiOverlayStyle.dark,
    ),
    filledButtonTheme: FilledButtonThemeData(
      style: FilledButton.styleFrom(
        backgroundColor: Brand.ink,
        foregroundColor: Brand.paper,
        disabledBackgroundColor: Brand.line,
        disabledForegroundColor: Brand.muted,
        minimumSize: buttonSize,
        shape: buttonShape,
        textStyle: buttonText,
        elevation: 0,
      ),
    ),
    outlinedButtonTheme: OutlinedButtonThemeData(
      style: OutlinedButton.styleFrom(
        foregroundColor: Brand.ink,
        minimumSize: buttonSize,
        shape: buttonShape,
        side: const BorderSide(color: Brand.line),
        textStyle: buttonText,
      ),
    ),
    textButtonTheme: TextButtonThemeData(
      style: TextButton.styleFrom(foregroundColor: Brand.ink, textStyle: textTheme.labelLarge),
    ),
    iconButtonTheme: IconButtonThemeData(style: IconButton.styleFrom(foregroundColor: Brand.ink)),
    cardTheme: const CardThemeData(
      color: Brand.mist,
      elevation: 0,
      margin: EdgeInsets.zero,
      shape: RoundedRectangleBorder(borderRadius: BorderRadius.all(Radius.circular(20))),
    ),
    inputDecorationTheme: InputDecorationTheme(
      filled: true,
      fillColor: Brand.mist,
      contentPadding: const EdgeInsets.symmetric(horizontal: 18, vertical: 18),
      labelStyle: const TextStyle(color: Brand.muted),
      floatingLabelStyle: const TextStyle(color: Brand.ink),
      border: const OutlineInputBorder(borderRadius: radius, borderSide: BorderSide.none),
      enabledBorder: const OutlineInputBorder(borderRadius: radius, borderSide: BorderSide.none),
      focusedBorder: const OutlineInputBorder(
        borderRadius: radius,
        borderSide: BorderSide(color: Brand.ink, width: 1.5),
      ),
      errorBorder: const OutlineInputBorder(
        borderRadius: radius,
        borderSide: BorderSide(color: Brand.danger),
      ),
    ),
    progressIndicatorTheme: const ProgressIndicatorThemeData(color: Brand.ink, linearTrackColor: Brand.line),
    dividerTheme: const DividerThemeData(color: Brand.line, thickness: 1, space: 1),
    snackBarTheme: SnackBarThemeData(
      backgroundColor: Brand.ink,
      contentTextStyle: textTheme.bodyMedium?.copyWith(color: Brand.paper),
      actionTextColor: Brand.accent,
      behavior: SnackBarBehavior.floating,
      shape: const RoundedRectangleBorder(borderRadius: BorderRadius.all(Radius.circular(14))),
    ),
    dialogTheme: DialogThemeData(
      backgroundColor: Brand.paper,
      surfaceTintColor: Colors.transparent,
      shape: const RoundedRectangleBorder(borderRadius: BorderRadius.all(Radius.circular(24))),
      titleTextStyle: textTheme.titleLarge,
    ),
    popupMenuTheme: PopupMenuThemeData(
      color: Brand.paper,
      surfaceTintColor: Colors.transparent,
      elevation: 3,
      shape: const RoundedRectangleBorder(borderRadius: BorderRadius.all(Radius.circular(14))),
      textStyle: textTheme.bodyLarge,
    ),
    listTileTheme: const ListTileThemeData(contentPadding: EdgeInsets.zero, iconColor: Brand.ink),
    chipTheme: base.chipTheme.copyWith(
      backgroundColor: Brand.mist,
      side: BorderSide.none,
      shape: const StadiumBorder(),
    ),
    textSelectionTheme: TextSelectionThemeData(
      cursorColor: Brand.ink,
      selectionColor: Brand.accent.withValues(alpha: 0.45),
      selectionHandleColor: Brand.ink,
    ),
  );
}

/// A small yellow label, e.g. "TESTNET" or "USDC".
class AccentTag extends StatelessWidget {
  const AccentTag(this.label, {super.key});

  final String label;

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
      decoration: const BoxDecoration(color: Brand.accent, borderRadius: BorderRadius.all(Radius.circular(6))),
      child: Text(
        label,
        style: Theme.of(context).textTheme.labelSmall?.copyWith(color: Brand.ink, fontWeight: FontWeight.w700),
      ),
    );
  }
}

/// "GlobalPay" with the yellow dot: the one place the accent is always visible.
class Wordmark extends StatelessWidget {
  const Wordmark({super.key, this.size = 22, this.color});

  final double size;

  /// The letters' color: ink by default, paper on a black card.
  final Color? color;

  @override
  Widget build(BuildContext context) {
    final style = Theme.of(context).textTheme.titleLarge?.copyWith(
      fontSize: size,
      fontWeight: FontWeight.w700,
      letterSpacing: -0.04 * size,
      color: color,
    );
    return Row(
      mainAxisSize: MainAxisSize.min,
      crossAxisAlignment: CrossAxisAlignment.end,
      children: [
        Text('GlobalPay', style: style),
        Padding(
          padding: EdgeInsets.only(left: size * 0.12, bottom: size * 0.22),
          child: Container(
            width: size * 0.28,
            height: size * 0.28,
            decoration: const BoxDecoration(color: Brand.accent, shape: BoxShape.circle),
          ),
        ),
      ],
    );
  }
}
