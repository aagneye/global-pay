# apps/mobile

The GlobalPay Flutter app. Users scan a PromptPay QR, confirm a locked USDC quote, sign it with their own wallet, and watch the payment settle. Android first; iOS builds need a Mac.

Stack: Flutter 3.32+, Riverpod 3, go_router, Dio with a client generated from the backend's OpenAPI spec, `on_chain` for signing, `mobile_scanner`, `flutter_secure_storage`.

## Status

Iterations 5 (the app), 8 (Add money), 9 (tap to pay), 10 (release hardening) and 11 (email sign-in with Privy) are built. The whole flow works against the local backend:

1. **Sign in:** with an email code (Privy embedded wallet, iteration 11), or the dev wallet in debug builds. The wallet signs the backend's Sign-In with Ethereum message.
2. **Verify:** mock KYC. The app opens once the user can pay.
3. **Home:** USDC balance, wallet address, recent payments.
4. **Scan:** camera, or paste the QR text (handy on emulators). The QR is checked on the device first.
5. **Confirm:**
   - the merchant, and the amount (entered by the user for a static QR);
   - what you pay, the rate and the fee;
   - a 60-second countdown.

   Paying signs the USDC authorisation for exactly that quote.
6. **Status:** polls until Paid, Refunded or Failed, with the transactions.
7. **Receive** (address QR with an EIP-681 USDC link) and **History** (payments, deposits and tap payments, sent and received).
8. **Add money** (iteration 8): pick a baht amount; the partner's checkout opens in a Custom Tab (never a WebView). The status screen re-checks when the app comes back, and shows "Added" only once the USDC is proved on-chain. Against the local backend, the checkout is the API's simulator page.
9. **Tap to pay** (iteration 9, [ADR 0010](../../docs/adr/0010-tap-to-pay.md)):
   - **Request** (receiver): enter a USDC amount, then hold the payer's phone to yours, or let them scan the QR.
   - **Pay by tap** (payer): while this screen is open, the phone answers taps as a contactless card. Its signing key never leaves the Android Keystore.
   - **Approve:** the payer sees who they're paying (with a "verified" badge only for verified names) and the amount, then approves with their fingerprint.
   - **"This phone":** the home screen's menu turns tap to pay off for this phone (its registration is revoked) and back on.
   - **Fingerprint-locked dev wallet:** with a strong biometric enrolled (or, on Android 11+, a screen lock), the dev wallet's key is stored only encrypted by a Keystore key that needs the fingerprint (or screen lock) for every signature.
   - **Native code** is in `android/app/src/main/kotlin/.../TapCard.kt` and `KeyVault.kt`.
10. **Release builds** (iteration 10): HTTPS only, no test keys, no logging, no backups, signed with your own key and shrunk by R8. See [Release build](#release-build).
11. **A fingerprint for every signature:** with Privy, each sign-in and payment first opens a token sealed by a Keystore key that needs the fingerprint (`lib/services/wallet/signature_gate.dart`, [ADR 0003](../../docs/adr/0003-embedded-non-custodial-wallet.md)). On Android 11 and later, a phone without a strong fingerprint (most face unlock) uses its screen lock instead. If the phone's fingerprints or screen lock change, the app asks the user to sign in again with their email. Release builds refuse to sign on a phone with neither (on Android 9 and 10, without a fingerprint). Debug builds skip the check there, so an emulator works without either; to try it, set a screen lock in the emulator's settings, or enrol a fingerprint and touch it from *Extended controls → Fingerprint*.
12. **Checked signatures:** before any wallet signs, the app compares the typed data with the payment on screen and its own settings (`lib/domain/signing/authorization_check.dart`), so a compromised backend can't get a different transfer signed.

The embedded wallet (Privy) is the default wallet when its IDs are set; see "Sign in with email (Privy)" below and [docs/roadmap.md](../../docs/roadmap.md).

## Layout

```
lib/
  main.dart                  ProviderScope + GlobalPayApp
  app/                       MaterialApp.router, routes and the sign-in/KYC guard, theme
  core/
    config/app_config.dart   settings from --dart-define (no secrets in the app)
    providers.dart           dependency graph (override in tests)
    storage/                 secure key-value storage (Keystore / Keychain)
    errors/, widgets/        AppException, shared widgets
  domain/
    models/                  money (BigInt minor units), quote, payment, onramp, tap-to-pay request, KYC, session, PromptPay QR
    promptpay/               PromptPay parser (shared vectors in packages/fixtures)
    signing/                 checks the typed data a wallet is asked to sign
  data/
    api/api_client.dart      Dio + bearer token + error mapping, around the generated client
    api/generated/           generated from packages/openapi/openapi.json: don't edit
    repositories/            auth (Sign-In with Ethereum), KYC, payments, account, onramp, p2p
    session_store.dart       the signed-in session, kept across restarts
  services/wallet/           WalletService, DevWalletService (local key), LocalKeySigner
                             (EIP-191 / EIP-712), PrivyWalletService (embedded wallet, behind
                             PrivyClient), WalletSwitch (the wallet the user signed in with)
  services/tap/              NFC card emulation and reader, the fingerprint vault (Kotlin in android/.../kotlin)
  services/push/             Firebase Cloud Messaging
  features/                  auth, kyc, home, receive, scan, pay, history, add_money, p2p
test/                        unit and widget tests; test/e2e runs against a live backend
tool/check_release.sh        checks a built release APK (signing, manifest, test keys)
```

Architecture rules:
- Screens use repositories through providers, never Dio or a wallet SDK directly.
- Wallets are reached only through `WalletService`.
- Money is `BigInt` in minor units, never `double`.

## Commands

```bash
flutter pub get
flutter analyze
flutter test
```

### Run against a local chain

Start the backend on anvil first (`services/api/README.md`, "Try a payment locally"). Then:

```bash
flutter run --dart-define=API_BASE_URL=http://10.0.2.2:3000 --dart-define=CHAIN_ID=31337 --dart-define=DEV_WALLET_PRIVATE_KEY=0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a
```

That key is anvil's public test account #4, which `DeployLocal.s.sol` funds with 10,000 test USDC. Without it the dev wallet makes a new, empty key. Paste a QR from `npm run qr:make` (in `services/api`) into the scan screen.

**Black screen on the emulator?** Some emulator images (e.g. Android 37 with 16 KB pages) can't run Flutter's default Impeller renderer. Add `--no-enable-impeller` to `flutter run`. For an installed debug APK:

```bash
adb shell am start -n com.globalpay.globalpay/.MainActivity --ez enable-impeller false
```

| `--dart-define` | Default | Meaning |
|---|---|---|
| `API_BASE_URL` | `http://10.0.2.2:3000` | Backend URL (`10.0.2.2` is your computer, as seen from the Android emulator). Release builds need `https://`. |
| `CHAIN_ID` | `84532` | Base Sepolia; `31337` for anvil |
| `SETTLEMENT_ADDRESS` | none | The `GlobalPaySettlement` contract. When set, the wallet refuses to sign a merchant payment to any other address. Set it for every real build. |
| `DEV_WALLET_PRIVATE_KEY` | none | Optional, local chains only: the dev wallet's key on first start. Never a real key: dart-defines end up in the app. Ignored by release builds. |
| `PRIVY_APP_ID`, `PRIVY_CLIENT_ID` | none | Email sign-in with Privy's embedded wallet (see below). Without them, debug builds offer only the dev wallet and release builds say sign-in isn't set up. |
| `FIREBASE_API_KEY`, `FIREBASE_APP_ID`, `FIREBASE_SENDER_ID`, `FIREBASE_PROJECT_ID` | none | Push for tap to pay, from your Firebase project's Android app settings (no `google-services.json` needed). Without them push is off and the payer's screen polls. |

### Sign in with email (Privy)

With `PRIVY_APP_ID` and `PRIVY_CLIENT_ID` set, the sign-in screen asks for an email, then the code Privy emails. That opens the user's embedded wallet (Privy creates it on first sign-in), which then signs the backend's Sign-In with Ethereum message as before. Privy keeps the key; GlobalPay never holds funds ([ADR 0003](../../docs/adr/0003-embedded-non-custodial-wallet.md)). Signing out also signs out of Privy; signing in again with the same email returns the same wallet.

The dev wallet button appears only in debug builds. A release build without the Privy IDs shows "Sign-in isn't set up" instead.

Set up a Privy app once:

1. Create an app at [dashboard.privy.io](https://dashboard.privy.io).
2. **Login methods:** turn on Email.
3. **App settings → Basics:** copy the **App ID** (`PRIVY_APP_ID`).
4. **App settings → Clients:** add an app client for the mobile app, allow the Android application ID `com.globalpay.globalpay`, and copy its **Client ID** (`PRIVY_CLIENT_ID`).

Both IDs are public identifiers, not secrets, but don't commit them: pass them at build time.

```bash
flutter run --dart-define=PRIVY_APP_ID=<app id> --dart-define=PRIVY_CLIENT_ID=<client id>
```

Notes:
- The SDK is `privy_flutter` 0.11.0. Its Android library needs **minSdk 28** (Android 9) and Kotlin 2.1+, so the app's minSdk is 28. Two of its dependencies ship the same `META-INF/versions/9/OSGI-INF/MANIFEST.MF`, which `android/app/build.gradle.kts` excludes.
- Embedded wallets sign EIP-712 data for any chain (the chain ID is in the typed data), so no network switch is needed for Base Sepolia.
- Only `lib/services/wallet/privy_sdk_client.dart` imports the SDK. Tests use `test/support/fake_privy.dart` instead.
- Google sign-in is supported by the SDK on Android but not wired up yet. It needs Google turned on in the dashboard, an allowed app URL scheme, Privy's `PrivyRedirectActivity` with that scheme in `AndroidManifest.xml`, and `privy.oAuth.login(provider: OAuthProvider.google, appUrlScheme: ...)`.

### Live backend test

`test/e2e` signs in, pays and waits for settlement through the app's own data layer, against a running backend:

```bash
flutter test test/e2e --dart-define=E2E_API_BASE_URL=http://127.0.0.1:3000
```

### Release build

```bash
flutter build apk --release --dart-define=API_BASE_URL=https://<your-api-host> --dart-define=CHAIN_ID=84532
```

The APK is `build/app/outputs/flutter-apk/app-release.apk` (`flutter build appbundle --release` makes a Play bundle). Add the `FIREBASE_*` defines for push. A release build:

- **Uses HTTPS only.** With a non-https `API_BASE_URL` the app stops at startup with an error naming `API_BASE_URL` (`AppConfig`). Android is also set to refuse plain HTTP (`android/app/src/main/res/xml/network_security_config.xml`); only the debug build type's own copy of that file allows it. The app-side check is the one that counts for API calls, because Dart's HTTP client doesn't follow Android's setting.
- **Ignores test keys.** `DEV_WALLET_PRIVATE_KEY` is ignored and not even compiled in, and the dev wallet isn't offered: users sign in with Privy, and without the Privy IDs the app says sign-in isn't set up.
- **Stays out of backups.** App data (the sealed wallet key, the session) never goes into cloud backups or device-to-device transfers: `allowBackup` and `fullBackupContent` are off, and `res/xml/data_extraction_rules.xml` excludes everything on Android 12+. This applies to debug builds too.
- **Is shrunk by R8.** Code is shrunk and obfuscated, and unused resources are dropped (`android/app/proguard-rules.pro`). R8 also removes `Log.v`, `Log.d` and `Log.i` calls, including libraries'. Keep `build/app/outputs/mapping/release/mapping.txt` from each published build: you need it to read that build's crash stack traces.
- **Logs nothing.** `test/release/no_logging_test.dart` fails on any `print`, `debugPrint`, `dart:developer` log, Dio `LogInterceptor` or logcat call, so tokens, signatures, keys and QR payloads can't leak into logs. `test/release/android_manifest_test.dart` keeps plain HTTP out of everything but the debug build type, and checks the backup settings.

#### Signing

Release builds are signed with the key described in `android/key.properties`. Without that file, Gradle warns and signs with the debug key: fine for trying a release build locally, never for publishing.

1. Create an upload key once, outside the repo, and back it up with its passwords. `keytool` comes with Java; Android Studio has one in its `jbr/bin` folder.

   ```bash
   keytool -genkeypair -v -keystore ~/globalpay-upload.jks -keyalg RSA -keysize 2048 -validity 10000 -alias upload
   ```

2. Create `android/key.properties`. `storeFile` is absolute, or relative to `android/`. Gradle stops if a field is missing. (keytool's default PKCS12 keystore uses one password for both.)

   ```properties
   storePassword=<keystore password>
   keyPassword=<same password>
   keyAlias=upload
   storeFile=C:/Users/<you>/globalpay-upload.jks
   ```

3. Build as above, then check the certificate (`apksigner` is in the Android SDK's `build-tools/<version>` folder):

   ```bash
   apksigner verify --print-certs build/app/outputs/flutter-apk/app-release.apk
   ```

Then check the APK against the launch checklist's app checks (A8 signing, A9 manifest and network security config, A10 test keys). It exits 1 if any fails, including when the APK is signed with the debug key:

```bash
bash tool/check_release.sh
```

Never commit `key.properties` or the keystore: both `.gitignore`s (`apps/mobile`, `apps/mobile/android`) exclude `key.properties`, `*.jks` and `*.keystore`. On CI, write both files from secrets before building.

### Regenerate the API client

After a backend route changes (`npm run openapi` in `services/api` updates `packages/openapi/openapi.json`):

```bash
dart run swagger_parser
```

```bash
dart run build_runner build --delete-conflicting-outputs
```

`retrofit` and `retrofit_generator` are pinned together: newer pairs need Dart 3.9+.
