# apps/mobile

The GlobalPay Flutter app. Users scan a PromptPay QR, confirm a locked USDC quote, sign it with their own wallet, and watch the payment settle. Android first; iOS builds need a Mac.

Stack: Flutter 3.32+, Riverpod 3, go_router, Dio with a client generated from the backend's OpenAPI spec, `on_chain` for signing, `mobile_scanner`, `flutter_secure_storage`.

## Status

Iteration 5 is done. The whole flow works against the local backend:

1. **Sign in:** the dev wallet signs the backend's Sign-In with Ethereum message.
2. **Verify:** mock KYC. The app opens once the user can pay.
3. **Home:** USDC balance, wallet address, recent payments.
4. **Scan:** camera, or paste the QR text (handy on emulators). The QR is checked on the device first.
5. **Confirm:**
   - the merchant, and the amount (entered by the user for a static QR);
   - what you pay, the rate and the fee;
   - a 60-second countdown.

   Paying signs the USDC authorisation for exactly that quote.
6. **Status:** polls until Paid, Refunded or Failed, with the transactions.
7. **Receive** (address QR with an EIP-681 USDC link) and **History** (payments and deposits).
8. **Add money** (iteration 8): pick a baht amount; the partner's checkout opens in a Custom Tab (never a WebView). The status screen re-checks when the app comes back, and shows "Added" only once the USDC is proved on-chain. Against the local backend, the checkout is the API's simulator page.
9. **Tap to pay** (iteration 9, [ADR 0010](../../docs/adr/0010-tap-to-pay.md)):
   - **Request** (receiver): enter a USDC amount, then hold the payer's phone to yours, or let them scan the QR.
   - **Pay by tap** (payer): while this screen is open, the phone answers taps as a contactless card. Its signing key never leaves the Android Keystore.
   - **Approve:** the payer sees who they're paying (with a "verified" badge only for verified names) and the amount, then approves with their fingerprint.
   - **Fingerprint-locked wallet:** with strong biometrics enrolled, the wallet key is stored only encrypted by a Keystore key that needs the fingerprint for every signature.
   - **Native code** is in `android/app/src/main/kotlin/.../TapCard.kt` and `KeyVault.kt`.

The embedded wallet (Privy) replaces the dev wallet in iteration 7. See [docs/roadmap.md](../../docs/roadmap.md).

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
    models/                  money (BigInt minor units), quote, payment, KYC, session, PromptPay QR
    promptpay/               PromptPay parser (shared vectors in packages/fixtures)
  data/
    api/api_client.dart      Dio + bearer token + error mapping, around the generated client
    api/generated/           generated from packages/openapi/openapi.json: don't edit
    repositories/            auth (Sign-In with Ethereum), KYC, payments, account
    session_store.dart       the signed-in session, kept across restarts
  services/wallet/           WalletService, DevWalletService (local key), LocalKeySigner
                             (EIP-191 / EIP-712), PrivyWalletService (iteration 7)
  features/                  auth, kyc, home, receive, scan, pay, history
test/                        unit and widget tests; test/e2e runs against a live backend
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
| `API_BASE_URL` | `http://10.0.2.2:3000` | Backend URL (`10.0.2.2` is your computer, as seen from the Android emulator) |
| `CHAIN_ID` | `84532` | Base Sepolia; `31337` for anvil |
| `EXPLORER_URL` | `https://sepolia.basescan.org` | Not used by the app yet; the backend sends transaction links |
| `DEV_WALLET_PRIVATE_KEY` | none | Optional, local chains only: the dev wallet's key on first start. Never a real key: dart-defines end up in the app. |
| `FIREBASE_API_KEY`, `FIREBASE_APP_ID`, `FIREBASE_SENDER_ID`, `FIREBASE_PROJECT_ID` | none | Push for tap to pay, from your Firebase project's Android app settings (no `google-services.json` needed). Without them push is off and the payer's screen polls. |

### Live backend test

`test/e2e` signs in, pays and waits for settlement through the app's own data layer, against a running backend:

```bash
flutter test test/e2e --dart-define=E2E_API_BASE_URL=http://127.0.0.1:3000
```

### Regenerate the API client

After a backend route changes (`npm run openapi` in `services/api` updates `packages/openapi/openapi.json`):

```bash
dart run swagger_parser
```

```bash
dart run build_runner build --delete-conflicting-outputs
```

`retrofit` and `retrofit_generator` are pinned together: newer pairs need Dart 3.9+.
