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
- **Google sign-in** isn't wired up (it needs a redirect scheme and `PrivyRedirectActivity`).
- **Not tried on a phone:** it needs a Privy app (an owner step). Unit and widget tests use a fake Privy client.

## Update: a fingerprint before every Privy signature (2026-11-14)

The owner chose to keep [ADR 0010](0010-tap-to-pay.md)'s promise of a fingerprint for every approval with Privy too.

- **Every Privy signature needs the fingerprint first:** "Sign in to GlobalPay" for Sign-In with Ethereum, "Approve this payment" for each USDC authorisation. Nothing reaches Privy until the check passes, so a cancelled prompt signs nothing.
- **The phone's hardware decides, not the app.** `FingerprintGate` (`lib/services/wallet/signature_gate.dart`) seals a random 32-byte token with the `KeyVault` AES key, which the Android Keystore releases only after a strong biometric through `BiometricPrompt` with a `CryptoObject`. Each check must decrypt that token, and the result must match the SHA-256 digest stored beside it. A bare `local_auth` prompt only reports "passed", which a tampered app can fake.
- **One prompt per signature.** The first check seals the token, and sealing is itself the fingerprint prompt.
- **Changed fingerprints lock it.** Adding or removing a fingerprint destroys the Keystore key. The gate then refuses every signature (`biometric_reset`) until the user signs in again with an email code, so someone who knows the phone's PIN can't add their own finger and pay. The fresh sign-in seals a new token (the vault replaces the destroyed key). A token that doesn't match its digest locks the gate the same way.
- **No strong biometric, no signature in release builds** (`biometric_unavailable`, "Set up a fingerprint…"). Debug builds skip the check on such phones, so emulators without a fingerprint still work.

Consequences:
- **It protects against someone holding an unlocked phone, not against a rooted one.** Malware on a rooted phone could call Privy directly, because Privy's key isn't bound to the fingerprint. Privy's own MFA for signing (a passkey or an authenticator app, checked by Privy) would cover that; it's listed under "Before real money" in the roadmap.
- **Phones with only weak biometrics can't pay.** Android counts most face unlock as weak, and `BIOMETRIC_STRONG` excludes it. Allowing the screen-lock PIN instead (Android 11 and later can bind a Keystore key to it) is an owner decision.
- **Not tried on a phone yet.** Unit and widget tests cover the gate with a fake vault, and the Kotlin builds. A real fingerprint, a cancel and a fingerprint change need a phone and the owner's Privy app.
