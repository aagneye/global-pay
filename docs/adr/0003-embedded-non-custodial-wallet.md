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
