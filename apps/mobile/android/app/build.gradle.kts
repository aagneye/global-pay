import java.util.Properties

plugins {
    id("com.android.application")
    id("kotlin-android")
    // The Flutter Gradle Plugin must be applied after the Android and Kotlin Gradle plugins.
    id("dev.flutter.flutter-gradle-plugin")
}

// Release signing key: android/key.properties (gitignored, never committed; see apps/mobile/README.md).
// Without it, release builds are signed with the debug key so local release builds still work.
val keyPropertiesFile = rootProject.file("key.properties")
val keyProperties = Properties().apply {
    if (keyPropertiesFile.exists()) keyPropertiesFile.inputStream().use { load(it) }
}
val hasReleaseKey = keyPropertiesFile.exists()
if (hasReleaseKey) {
    val missing = listOf("storeFile", "storePassword", "keyAlias", "keyPassword").filter { keyProperties.getProperty(it).isNullOrBlank() }
    if (missing.isNotEmpty()) throw GradleException("android/key.properties is missing: ${missing.joinToString()}")
} else if (gradle.startParameter.taskNames.any { it.contains("release", ignoreCase = true) }) {
    // quiet, not warn: `flutter build` runs Gradle with -q, which hides warnings.
    logger.quiet(
        "WARNING: android/key.properties not found, so this release build is signed with the DEBUG key. " +
            "Don't publish it. See apps/mobile/README.md, \"Release build\".",
    )
}

android {
    namespace = "com.globalpay.globalpay"
    // 36: needed by CameraX 1.6 (mobile_scanner 7.5).
    compileSdk = 36
    ndkVersion = flutter.ndkVersion

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_11
        targetCompatibility = JavaVersion.VERSION_11
    }

    kotlinOptions {
        jvmTarget = JavaVersion.VERSION_11.toString()
    }

    defaultConfig {
        // TODO: Specify your own unique Application ID (https://developer.android.com/studio/build/application-id.html).
        applicationId = "com.globalpay.globalpay"
        // You can update the following values to match your application needs.
        // For more information, see: https://flutter.dev/to/review-gradle-config.
        // firebase_messaging (push for tap to pay) needs Android 7 (API 24).
        minSdk = 24
        targetSdk = flutter.targetSdkVersion
        versionCode = flutter.versionCode
        versionName = flutter.versionName
    }

    signingConfigs {
        if (hasReleaseKey) {
            create("release") {
                // A relative storeFile is resolved from android/, next to key.properties.
                storeFile = rootProject.file(keyProperties.getProperty("storeFile"))
                storePassword = keyProperties.getProperty("storePassword")
                keyAlias = keyProperties.getProperty("keyAlias")
                keyPassword = keyProperties.getProperty("keyPassword")
            }
        }
    }

    buildTypes {
        release {
            signingConfig = signingConfigs.getByName(if (hasReleaseKey) "release" else "debug")
            // R8: shrink, optimise and obfuscate the code, then drop unused resources. The Flutter
            // plugin turns these on by default; set here so release builds don't depend on that.
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
        }
    }
}

flutter {
    source = "../.."
}

dependencies {
    // BiometricPrompt with a CryptoObject, for the fingerprint-locked wallet key (KeyVault.kt).
    implementation("androidx.biometric:biometric:1.1.0")
}
