# apps/mobile

The GlobalPay Flutter app. Users scan a PromptPay QR, confirm a locked USDC quote, sign it with their own wallet, and watch the payment settle. Android first; iOS builds need a Mac.

Stack: Flutter 3.32+, Riverpod, go_router, Dio.

## Layout

```
lib/
  main.dart                  ProviderScope + GlobalPayApp
  app/                       MaterialApp.router, routes, theme
  core/
    config/app_config.dart   settings from --dart-define (no secrets in the app)
    providers.dart           dependency graph (override in tests)
    errors/                  AppException
    widgets/                 shared widgets (PlaceholderView for unbuilt screens)
  domain/
    models/                  money (BigInt minor units), quote, payment, PromptPay QR
    promptpay/               PromptPay parser (shared vectors in packages/fixtures)
  data/
    api/api_client.dart      Dio client; generated OpenAPI client goes in api/generated/
    repositories/            auth (Sign-In with Ethereum), payments, account
  services/wallet/           WalletService interface, plus:
                             DevWalletService (dev/tests), PrivyWalletService (embedded wallet)
  features/                  auth, kyc, home, receive, scan, pay, history
test/                        widget and unit tests
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
flutter run --dart-define=API_BASE_URL=http://10.0.2.2:3000
```

| `--dart-define` | Default | Meaning |
|---|---|---|
| `API_BASE_URL` | `http://10.0.2.2:3000` | Backend URL (`10.0.2.2` is your computer, as seen from the Android emulator) |
| `CHAIN_ID` | `84532` | Base Sepolia |
| `EXPLORER_URL` | `https://sepolia.basescan.org` | Transaction links |

## Status

Iteration 1 is a skeleton. Every screen in the payment flow exists as a placeholder, so you can click through the whole flow from Sign in to Payment status. The real screens, wallet and API calls come in iteration 5, and the embedded wallet in iteration 7. See [docs/roadmap.md](../../docs/roadmap.md).
