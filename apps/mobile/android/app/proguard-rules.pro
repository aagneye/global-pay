# R8 rules for release builds (build.gradle.kts: isMinifyEnabled, isShrinkResources).
#
# Already covered elsewhere, so not repeated here:
# - Flutter: the Flutter Gradle plugin adds flutter_proguard_rules.pro (keeps every FlutterPlugin).
# - Manifest components (MainActivity, TapHostApduService, firebase_messaging's service and receiver):
#   kept by the rules AAPT2 generates from the merged manifest.
# - firebase_core / firebase_messaging: Firebase finds their ComponentRegistrar by class name, and
#   firebase-components' own consumer rules keep every ComponentRegistrar.
# - androidx.biometric, mobile_scanner (ML Kit), flutter_secure_storage (Tink): their own consumer rules.
# - nfc_manager, url_launcher, path_provider: Pigeon method channels, no reflection.

# Our native code (MainActivity's method channels "globalpay/tap_card" and "globalpay/vault", TapCard.kt,
# KeyVault.kt) uses no reflection, but it's small and runs the NFC and fingerprint paths: keep it whole
# so release behaves exactly like debug and its stack traces stay readable.
-keep class com.globalpay.globalpay.** { *; }

# Line numbers in crash stack traces (retrace with build/app/outputs/mapping/release/mapping.txt).
-keepattributes SourceFile,LineNumberTable
-renamesourcefileattribute SourceFile

# Log hygiene: remove verbose, debug and info logcat calls (ours and every library's) from release builds,
# so nothing chatty, like tokens or payloads a library logs while debugging, reaches logcat.
-assumenosideeffects class android.util.Log {
    public static int v(...);
    public static int d(...);
    public static int i(...);
}
