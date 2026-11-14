# ADR 0003: Embedded, non-custodial wallet

- **Status:** Accepted
- **Date:** 2026-11-12

## Context

The first users are freelancers, not crypto experts. Seed phrases cause drop-off and lost funds. Holding user funds ourselves (custodial) would need custody licensing in every market.

## Decision

- Users get an **embedded wallet**: they sign in with email or Google, and a provider SDK (Privy first, Web3Auth as fallback) secures the key. GlobalPay never controls the funds.
- The app talks to wallets only through its own **`WalletService`** interface (`address`, `signMessage`, `signTypedData`).
- **`DevWalletService`** (a local key in secure storage) is used for development and tests until a provider app ID exists.
- The backend authenticates users with **Sign-In with Ethereum (EIP-4361)**, which works with any wallet.

## Consequences

- Funds stay with the user until they authorise a specific payment, which keeps GlobalPay out of custody before payment.
- Switching provider means writing one new `WalletService` implementation.
- Account recovery depends on the provider's recovery options.
- External wallets (MetaMask, WalletConnect) can be added later as another `WalletService`, because `pay()` is permissionless.

## Update: Privy is the default wallet (iteration 11, 2026-11-14)

- **Privy is the app's wallet.** `PrivyWalletService` (`privy_flutter` 0.11.0) signs in with an email and a one-time code; Privy creates the embedded wallet on first sign-in and restores its session on later launches. `WalletSwitch` remembers which wallet the user signed in with.
- **It must be an EOA.** Configure Privy for embedded EOA wallets, not smart wallets. The backend checks Sign-In with Ethereum offline (no ERC-1271), and `GlobalPaySettlement` calls USDC's `v, r, s` form of EIP-3009, so only plain ECDSA signatures work. The app refuses anything but a 65-byte signature.
- **The dev wallet is for development.** `DevWalletService` is offered only in debug builds and tests. A release build without `PRIVY_APP_ID` and `PRIVY_CLIENT_ID` says sign-in isn't set up.
- **The app checks what it signs.** Before any wallet signs, `authorization_check.dart` compares the typed data with what the screen shows and with the app's settings (chain, USDC, recipient, amount, nonce, expiry, and the settlement contract when `SETTLEMENT_ADDRESS` is set), so a compromised backend can't get a different transfer signed.
- **Recovery** is Privy's (email). The fingerprint-sealed dev key and its loss on re-enrolment no longer matter for real users.
- **Android needs API 28.** Privy's Android library is built for Android 9, so the app's `minSdk` went from 24 to 28. This is an owner decision: it drops Android 7 and 8 phones.

Not settled yet:
- **No fingerprint per Privy signature.** The dev wallet's key needed a strong biometric for every signature ([ADR 0010](0010-tap-to-pay.md)). Privy signs without one. The owner decides between gating Privy signatures behind a `BiometricPrompt` with a `CryptoObject` (e.g. opening a vault-sealed value before each signature) and Privy's own MFA for signing.
- **Google sign-in** isn't wired up (it needs a redirect scheme and `PrivyRedirectActivity`).
- **Not tried on a phone:** it needs a Privy app (an owner step). Unit and widget tests use a fake Privy client.
