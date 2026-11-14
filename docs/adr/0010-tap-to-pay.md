# ADR 0010: Tap to pay: phones identify the payer, the payer approves with their fingerprint

- **Status:** Accepted
- **Date:** 2026-11-15

## Context

People want to pay each other in person as easily as tapping a card. The similar app we reviewed (Tap2ETH) uses the payer's bank card as the signer. Our research ([production rails](../research/production-rails.md#3-tap-to-pay)) found three problems with that:

- **Old keys:** it relies on EMV DDA with 1024-bit RSA keys.
- **Fraud and compliance:** it exposes the card to NFC relay fraud and brings PCI DSS scope.
- **Unproven:** it has been verified with only one real card.

Push notifications are also part of the plan: the payer may not have the app open when tapped.

## Decision

**Phone to phone.** The payer's phone acts as a contactless card (Android host card emulation) under GlobalPay's own application ID, `F0 47 50 41 59 00 01`. The receiver's phone reads it with `IsoDep`.

**The tap only identifies the payer:**

1. The receiver creates a request (`POST /p2p/requests`) for an amount in USDC, with one-time values:
   - a random 32-byte challenge;
   - a random EIP-3009 nonce;
   - an expiry two minutes ahead.

   The receiver's name is copied from their profile at this point, never taken from the request.
2. The receiver's phone sends the challenge over NFC.
3. The payer's phone answers with:
   - the device ID the backend gave it;
   - an ECDSA P-256 signature over `"GLOBALPAY-TAP-1" ‖ challenge`, made by a key that never leaves the Android Keystore (StrongBox when available).

   The prefix keeps that key from signing anything else over NFC.
4. The receiver's phone forwards the answer (`POST /p2p/requests/:id/tap`). The backend checks the signature against the device's registered public key, then sets the payer and uses up the challenge in one conditional update.

**The payer's phone only answers taps while "Pay by tap" is open** (the app arms it for 60 seconds at a time) and the phone is unlocked (`requireDeviceUnlock`). Otherwise it answers `69 85`.

**The payer approves on their own phone:**

1. The backend sends a push (FCM HTTP v1) carrying only the request ID, with a generic title.
   - While "Pay by tap" is open, the app also polls `GET /p2p/incoming`, so push is a convenience, not a dependency.
2. The approve screen shows:
   - the receiver's name, with a "verified" badge only when it comes from identity verification;
   - their address;
   - the amount.
3. Approving signs a USDC `TransferWithAuthorization` (EIP-3009) that the backend builds from the stored request (`GET /p2p/requests/:id/authorization`).
4. On approval, the backend checks every field (from, to, value, validAfter, validBefore, nonce) by verifying the signature against the stored request. It then relays the transfer through the existing relayer, which pays the gas. The token's own nonce check stops it from landing twice.

**The wallet key is unlocked with the fingerprint for every signature.** It's encrypted by an AES-GCM key in the Android Keystore that requires strong biometric authentication for each use. The cipher is unlocked only through `BiometricPrompt` with a `CryptoObject`, because a biometric check alone (as `local_auth` does) can be bypassed. Enrolling a new fingerprint invalidates the key. A key stored the old way is moved into the vault. Phones without strong biometrics fall back to the previous dev-wallet storage.

**QR fallback:** the receiver's screen also shows `globalpay://pay?r=<id>&c=<challenge>`. A payer who scans it claims the request (`POST /p2p/requests/:id/claim`), which uses up the same one-time challenge.

**Limits:**
- requests expire after 2 minutes;
- each challenge works once;
- a receiver may have 3 open requests;
- a payer may have 3 requests waiting for their approval, so a stranger can't flood them with taps;
- one request can ask for at most 1,000 USDC;
- both sides must have passed KYC.

All of these are settings (`P2P_*`).

**Requests live in Postgres** (`PaymentRequest`, `Device`). A worker expires unapproved requests, and records relayed transfers as COMPLETED or FAILED from their receipts. On completion it notifies the receiver.

**Push without an SDK:** the backend signs a service-account JWT for an OAuth token and calls FCM HTTP v1 directly, rather than depending on `firebase-admin`. Tokens that FCM reports as `UNREGISTERED` are forgotten. The app sets Firebase up from `--dart-define`s, with no `google-services.json`, and push is off without them.

## Consequences

- **Relay attacks only identify.** Someone relaying the NFC exchange could make a request look tapped by a nearby phone. But the payer still sees the name and amount, and must approve with their fingerprint. Requiring an unlocked phone and an open screen narrows this further.
- **Names are self-declared for now.** Mock KYC doesn't verify names, so every name shows as "not verified", and the app says so.
- **Android only:** iOS restricts host card emulation, so iPhones can use only the QR.
- **Losing fingerprints loses the dev wallet.** If fingerprints change, the sealed key can't be opened. That's acceptable for a testnet dev wallet; the Privy wallet (iteration 11) has recovery.
- **Not done yet:**
  - **No hardware test:** a tap between two physical phones, and push arriving while the app is closed, need two NFC phones and a Firebase project.
  - **No device attestation:** the backend can't yet check that a key really lives in a phone's hardware.

## Update (iterations 10 and 11, 2026-11-14)

- **APPROVING.** Approving first moves the request SENDER_IDENTIFIED → APPROVING (conditionally), so the receiver can't cancel it and the worker can't expire it while the transfer is relayed. The hash is recorded just before the transfer is broadcast. A request with no hash had nothing sent and goes back to SENDER_IDENTIFIED; one with a hash is followed to COMPLETED or FAILED by its receipt. Before this, a cancel or expiry during approval could move the money while the request said it hadn't.
- **A daily limit per sender.** A sender may send at most `P2P_DAILY_LIMIT_USDC` (2,000 USDC) by tap in any 24 hours, counting APPROVING, SUBMITTED and COMPLETED requests. It's separate from the THB limits on merchant payments.
- **History.** Sent and received tap payments show in the app's History. A received one isn't shown again as a deposit.
- **"This phone" switch.** The home screen's menu can turn tap to pay off for the phone, which revokes its device registration (`DELETE /devices/:id`); turning it back on registers the phone again.
- **The app checks the transfer before signing** it: recipient, amount, token, chain and nonce must match the request on screen.
- **The fingerprint step depends on the wallet.** With the dev wallet, every signature still needs a strong biometric. With Privy (iteration 11), the default wallet, it doesn't yet; see [ADR 0003](0003-embedded-non-custodial-wallet.md) for the open decision.
- **Stuck transfers** (no receipt after `OPS_STUCK_TX_AFTER_MS`) appear on `/ops`.

## Update: the fingerprint for Privy too (2026-11-14)

Approving a tap payment needs the fingerprint again with either wallet. Before each Privy signature, the app opens a token sealed by the same Keystore key as the dev wallet's vault, so the hardware enforces the check. The rules, including the lock after a fingerprint change, are in [ADR 0003](0003-embedded-non-custodial-wallet.md#update-a-fingerprint-before-every-privy-signature-2026-11-14). The vault now replaces its key when fingerprints change, instead of failing to seal anything again.
