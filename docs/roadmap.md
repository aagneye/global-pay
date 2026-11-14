# Roadmap

The demo was built in iterations 1–5; iterations 6–11 turn it into a product. Each one ends with its tests passing and is committed as small, atomic commits.

**Demo goal (iterations 1–5, done):** in the Flutter app, scan a PromptPay QR, pay with test USDC, and watch a simulated baht payout settle, or refund if the payout fails.

**Product goal (iterations 6–11):** confirmed payouts through a real partner, a way to add money, tap-to-pay between people, and a hardened release, on Base Sepolia first.

## Iteration 1: Foundation ✅

Structure, architecture and docs. No business logic yet.

- [x] Monorepo layout, repo config (`.gitignore`, `.gitattributes`, `.editorconfig`), Postgres via Docker Compose
- [x] Docs: [scope](scope.md), [architecture](architecture.md), [ADRs](adr/), [setup](setup.md), this roadmap
- [x] Contracts: Foundry layout and interfaces (`IGlobalPaySettlement`, `IERC3009`)
- [x] Backend skeleton:
  - domain model, ports, adapter stubs, modules, workers
  - Fastify bootstrap with `/health`
  - Prisma schema
- [x] Mobile skeleton:
  - routing and placeholder screens for the whole flow
  - domain models, `WalletService` interface, API client shell
- [x] PromptPay QR test vectors in `packages/fixtures`

**Done when:** `npm run typecheck` and `npm test` pass in `services/api`, and `flutter analyze` and `flutter test` pass in `apps/mobile`.

## Iteration 2: Settlement contract ✅

- [x] Foundry 1.9 installed. forge-std v1.17.0 and OpenZeppelin v5.7.0 pinned as submodules.
- [x] `GlobalPaySettlement`:
  - roles, `Pausable`, `ReentrancyGuard`, EIP-712 quote verification
  - `pay` via `receiveWithAuthorization`, with a received-amount check
  - `markSettled` and `refund`
  - token allowlist and treasury
  - not upgradeable, and only the admin can unpause ([ADR 0006](adr/0006-immutable-settlement-contract.md))
- [x] `MockUSDC3009` (with its own tests) and a broken-token mock.
- [x] Tests:
  - happy paths and the EIP-712 encoding lock
  - failure cases: expired, replayed, wrong signer, tampered quote, wrong user wallet, token not allowed, zero amount, paused, transfer mismatch
  - status rules and role checks
  - fuzz tests on amounts and expiry
- [x] `script/Deploy.s.sol` (from `.env`) and `script/DeployLocal.s.sol` (anvil). Both were run against a local chain.

**Result:** `forge test` passes, and coverage of `GlobalPaySettlement` is 100% for lines, statements, branches and functions. `forge fmt --check` and `forge lint` are clean.

## Iteration 3: Backend core ✅

- [x] Prisma client with `@prisma/adapter-pg`, the first migration, and repositories behind ports. Database tests run against real Postgres when `TEST_DATABASE_URL` is set.
- [x] PromptPay parser and builder in `src/lib/promptpay`, passing every shared vector. A new `invalid_field` error and vector cover bad values in a well-formed QR. `npm run qr:make` prints demo QRs.
- [x] Rates from Coinbase's public feed, parsed exactly from decimal strings, plus a fixed rate for offline work. Quote maths in `bigint`, rounded up, with a 1% spread by default.
- [x] EIP-712 quote signer (viem). Its digest and signature match `GlobalPaySettlement.hashQuote` exactly.
- [x] Sign-In with Ethereum: the server writes the message, then verifies the domain, URI, chain, expiry, signature and one-time nonce, and issues a JWT. An auth hook protects routes.
- [x] Mock KYC (approved at tier 1), with per-payment and rolling 24-hour limits enforced on quotes.
- [x] OpenAPI spec generated from the zod route schemas, served at `/docs`.

**Result:** 125 tests pass. On a local stack (anvil, Postgres, live rate), `POST /quotes` returned a signed quote, and the deployed contract accepted it in `pay()` together with the user's USDC authorisation.

## Iteration 4: Settlement loop on a local chain ✅

- [x] viem `SettlementGateway`:
  - `pay`, `markSettled`, `refund`
  - receipts, events, on-chain payment status, balances, and the token's EIP-712 domain
  - reverts decoded to the contract's error names
- [x] Relayer:
  - simulate before sending, so nothing is sent when the contract would revert
  - queued sends with a tracked nonce, re-read when the node says it's wrong
  - local signing, so resending after a timeout is safe
  - receipt waiting
- [x] Indexer:
  - saved block cursor, confirmation depth, chunked log queries
  - repeated events are harmless, and payments relayed by others are tracked
  - reconciles stuck SUBMITTED payments (reverted, or never landed before the quote expired)
- [x] Payout worker with a stateless `SimulatedPromptPayProvider`. It settles or refunds, checks the on-chain status first, and every step can be repeated ([ADR 0007](adr/0007-chain-is-the-source-of-truth.md)).
- [x] Payment API:
  - `POST /payments` (signature, expiry and limit checks, then `202 SUBMITTED`)
  - `GET /payments/:id` with explorer links
  - `GET /me/balance`, `GET /me/payments`
- [x] Integration test on anvil:
  - deploys with `script/DeployLocal.s.sol`, then runs the full flow through the HTTP API and the real chain code
  - settle path, refund path, a rejected payment, and concurrent payments with a nonce clash
  - checks our ABI against the compiled contract

**Result:** 165 tests pass, including the anvil integration test for both paths, on in-memory storage and on Postgres. The real server with its workers on timers also settled live payments on anvil in about 3–4 seconds each.

## Iteration 5: Mobile app ✅

- [x] Packages: `mobile_scanner`, `qr_flutter`, `flutter_secure_storage`, `json_serializable` + `build_runner`, and `on_chain` for signing. `on_chain` is maintained and supports EIP-712; `eth_sig_util` is abandoned. `freezed` wasn't needed.
- [x] `DevWalletService`: a key in secure storage (or a dart-defined test key), with EIP-191 and EIP-712 signing. Its signatures match viem's byte for byte (`packages/fixtures/wallet`).
- [x] Dart API client generated by `swagger_parser` from `packages/openapi/openapi.json`. The backend now names its operations and schemas, and a test keeps the committed spec in step with the routes.
- [x] Sign-In with Ethereum with a saved session; mock KYC; a router guard that sends users to sign-in or KYC.
- [x] Dart PromptPay parser, passing every shared vector.
- [x] Screens:
  - Scan (camera or pasted text) → Confirm (live quote, rate, fee, countdown) → sign → Status (polling, transactions)
  - Home (balance, recent payments), Receive (address QR + EIP-681 link), History
- [x] Android: minSdk 23, Android Gradle plugin 8.9.1 and compileSdk 36 (needed by CameraX 1.6), and plain HTTP to the local backend in debug builds only.

**Result:** 46 app tests pass: unit tests, and widget tests of the whole flow against a fake backend. The live-backend test exercises the app's data layer against the real backend and anvil: sign-in, quote, signature, payment and settlement.

On the Android emulator, signed in with anvil's test account, a ฿180.00 PromptPay QR was quoted at the live rate and paid in USDC. It settled in about 5 seconds, and the balance dropped by exactly the quoted amount.

Two bugs that the fakes had hidden were found and fixed:
- an empty request body was sent as JSON;
- unset optional fields were sent as `null`.

## From demo to product (iterations 6–11)

A review of a similar app listed what separates a demo from a real product: a payout that is actually confirmed, a way to add money, tap payments with push, and production hardening. The research behind this plan (partners, endpoints, regulation) is in [research/production-rails.md](research/production-rails.md).

## Iteration 6: Real payout confirmation and operations ✅

The payout is now checked properly instead of trusted. It's built against the **Xendit** payouts sandbox; the simulated partner stays for local tests. The rules are in [ADR 0008](adr/0008-payout-outcomes-and-reconciliation.md).

- [x] **Payout outcomes:** `PENDING`, `SUCCEEDED` (with the bank reference), `FAILED`, `UNKNOWN`, `REVERSED`. Every partner answer and webhook is stored as a `PayoutEvent`. Migration `20261113000000_payout_outcomes` backfills the idempotency key of existing payouts.
- [x] **No double payout:** the idempotency key (the payment ID) is saved before the partner is called; before any retry, `PayoutTracker` looks the payout up by that key.
- [x] **Settle and refund rules:** settle only on SUCCEEDED with a reference; refund only on a definite failure. Anything unclear becomes UNKNOWN: timeouts, 5xx errors, duplicates, a success with no reference, or still pending after 30 minutes. It is re-checked with backoff (30 s up to 1 h) and never settled or refunded automatically.
- [x] **Quote guards:** quotes refuse QRs the rail can't pay (422 `merchant_not_supported`), and refuse payments when the partner's float would drop below the buffer or can't be read (503 `payouts_unavailable`).
- [x] **`XenditPayoutProvider`** (v2 payouts):
  - `Idempotency-key` header;
  - lookup by `reference_id`;
  - cached balance;
  - sandbox test destinations (refused in production);
  - constant-time webhook token check.
- [x] **Webhook:** `POST /webhooks/payouts/:partner` re-fetches the payout before acting.
- [x] **Operator console** at `/ops`, behind its own token:
  - exceptions (stuck PAID, UNKNOWN, escalated UNKNOWN, reversals, partner errors, failing settle or refund, conflicts);
  - health (relayer gas, payout float);
  - actions: re-check, mark paid (needs a reference), approve refund (after a cooling-off period, and only if the partner has no record). Each action re-checks the partner first and is written to the `OpsAction` audit log.
- [x] **API and app:** `Payment.payout {status, provider, reference}`. The app shows "Merchant paid" with the bank reference only for SUCCEEDED, and "Needs review" for UNKNOWN or REVERSED.

**Result:** 223 backend tests pass, against Postgres (`prisma dev`) and anvil. They cover:
- every Xendit status, timeouts, 5xx errors and duplicates;
- the retry that looks up before creating;
- UNKNOWN never settling or refunding;
- deadline and backoff;
- webhook re-fetch, reversal and operator rules.

The anvil integration test now covers UNKNOWN → operator marks paid → settled on-chain. 49 app tests pass, including "Needs review".

**Not done yet:** the Xendit sandbox smoke run. `npm run xendit:sandbox` is ready but needs the owner's Xendit test key; it moves to iteration 7, with the webhook tunnel.

## Iteration 7: Base Sepolia (in progress)

The runbook is [testnet.md](testnet.md).

**Done so far:**
- [x] **Rehearsal on a fork of Base Sepolia** (`test/integration/base-sepolia-fork.test.ts`), against Circle's real test USDC:
  - the real `Deploy.s.sol` with fresh keys;
  - a gasless `pay()` through USDC's `receiveWithAuthorization`;
  - the indexer;
  - `markSettled` and `refund`.

  Both pass.
- [x] **`npm run testnet`:**
  - `init` makes testnet keys into gitignored files;
  - `status` checks balances, the deployment and roles on chain;
  - `record` saves the contract address and start block;
  - `pay` runs one payment through the API.
- [x] **Indexer range fix:** Base Sepolia's public RPC caps `eth_getLogs` at 200 blocks, and the indexer asked for 2,000. Now `INDEXER_MAX_BLOCK_RANGE` (default 200) sets the range, and the indexer warns when a public chain would be scanned from block 0. Checked against the public RPC.
- [x] **Running against the testnet:** `npm run dev:testnet` runs the API with `.env.base-sepolia`.

**Waiting on funding** (owner): Base Sepolia ETH for the deployer and relayer, and Circle test USDC for the test payer. Then:

1. Deploy the contract and verify it on Basescan.
2. Point the backend at Base Sepolia, Circle's test USDC and the Xendit sandbox; expose the webhook through a tunnel. First run `npm run xendit:sandbox` (balance, THB channels, one test payout) with the owner's test key.
3. End-to-end test: a 100 THB payment settles with a Xendit reference, a forced payout failure refunds, and a forced UNKNOWN shows on the operator page.

**Done when:** all three are visible on Basescan and the operator page.

## Iteration 8: Add money ✅ (sandbox run pending)

The rules are in [ADR 0009](adr/0009-add-money-proved-on-chain.md).

- [x] **Orders** (`OnrampOrder`: CREATED, PENDING, COMPLETED, FAILED, EXPIRED) and **deposits** (`Deposit`), in migration `20261114000000_onramp_and_deposits`.
- [x] **`MoonPayOnrampProvider`:**
  - widget URL signed over its query string;
  - order lookup by our order ID;
  - `Moonpay-Signature-V2` webhooks checked over the raw body, with a five-minute replay window;
  - the sandbox host by default.
- [x] **Proof on-chain:** COMPLETED only after a confirmed `Transfer` to the order's wallet, for the amount MoonPay reported. A unique index stops one transfer completing two orders, and a partner sending to another wallet never completes the order. The delivery chain is configurable, because the sandbox delivers on Ethereum Sepolia.
- [x] **Expiry** after an hour, but only once the partner confirms nothing was paid. An expired order still completes if the payment turns up.
- [x] **Deposit watcher:** incoming USDC to users' wallets, in 200-block ranges, skipping refunds. `GET /me/deposits` links each deposit to its order.
- [x] **Simulated onramp for local use:** a checkout page on the API that mints mock USDC on anvil, so the whole flow runs without MoonPay keys. Production refuses it.
- [x] **App:**
  - Add money: a baht amount, then the checkout in a Custom Tab, never a WebView;
  - the order status screen re-checks when the app comes back to the foreground;
  - History shows payments and deposits together.

**Result:**
- **Tests:** backend tests cover MoonPay URL signing, status mapping, and webhooks (valid, tampered, wrong key, replayed). They also cover the on-chain checks: not yet mined, reverted, wrong amount, wrong recipient, wrong token, a transfer used twice, another wallet. Expiry and recovery, and the deposit watcher, are covered too.
- **On anvil:** the integration test runs the simulated purchase, mints, proves the order COMPLETED, and finds the deposit.
- **In the app:** 52 tests pass, including the Add-money flow.

**Not done yet:**
- **A MoonPay sandbox purchase:** it needs the owner's MoonPay sandbox keys.
- **A deposit on Base Sepolia:** this waits on iteration 7's funding.
- **The Custom Tab on a device:** it's tested in widget tests only, not yet on an emulator or phone.
- **Stuck orders on `/ops`:** they don't show there yet. (Since iteration 10 the worker re-checks expired orders for 24 hours, so a late payment completes without a webhook.)

## Iteration 9: Tap to pay ✅ (two-phone test pending)

The rules are in [ADR 0010](adr/0010-tap-to-pay.md).

- [x] **Contracts:** `transferWithAuthorization` on the mock USDC, sharing nonces with `receiveWithAuthorization`. 5 new Foundry tests; all 47 pass.
- [x] **Backend models:** `Device` (hardware P-256 key, push token) and `PaymentRequest`, plus a profile name, in migration `20261115000000_tap_to_pay`.
- [x] **Tap check:** the payer's phone signs `"GLOBALPAY-TAP-1"` followed by the one-time challenge. The backend verifies the signature against the registered key, then sets the payer and uses up the challenge in one conditional update. The QR claim uses the same challenge.
- [x] **Approve:** the backend builds the `TransferWithAuthorization` from the stored request, checks the signature against it, and relays it through the relayer. A worker records COMPLETED or FAILED from the receipt, and expires requests after 2 minutes.
- [x] **Push:** FCM HTTP v1 with a service-account JWT, no SDK. The message carries only the request ID, and stale tokens are forgotten. Without credentials, push is off and the apps poll.
- [x] **Limits:** 3 open requests per receiver, 3 waiting per payer, at most 1,000 USDC a request, KYC for both sides.
- [x] **App:**
  - Request: amount, then an NFC read, with the QR as fallback;
  - Pay by tap: the phone is armed while the screen is open;
  - Approve: the recipient's name with a verified badge, the amount, and a fingerprint;
  - scanning a request QR;
  - opening the approve screen from a push.
- [x] **Android:**
  - `TapHostApduService` (card emulation), answering only when armed and unlocked;
  - a Keystore P-256 device key (StrongBox when available);
  - `KeyVault`: an AES-GCM key that needs a strong biometric for every use, through `BiometricPrompt` and `CryptoObject`. The dev wallet's key moves into it.
  - minSdk raised from 23 to 24 (Android 7), because firebase_messaging needs it.

**Result:** 291 backend tests pass, against Postgres, anvil and the fork. They cover:
- tap signatures: wrong key, reused challenge, revoked phone;
- another user trying to approve;
- a changed amount or recipient;
- expiry, rate limits, the QR claim, and push token clean-up.

The anvil test runs request → tap → approve → relay, checks both balances, and refuses a replay. 65 app tests pass, including both sides of a tap payment and the QR path, with fake NFC and push.

**Not done yet:**
- **On hardware:** the tap between two physical Android phones and push with the app closed need two NFC phones and a Firebase project. The native code compiles, but has only been exercised through fakes.
- **Verified names:** mock KYC doesn't verify names, so all names show as "not verified".

**Fixed in iteration 10** (found in review):
- a cancel or expiry while an approval was being relayed could hide a transfer that happened (now the APPROVING status);
- there was no daily limit per sender;
- sent tap payments were missing from History;
- a phone couldn't turn tap to pay off.

## Iteration 10: Production hardening ✅ (release key pending)

What "release-ready" means is written down in the [threat model](security.md), the [key rotation runbook](runbooks/key-rotation.md) and the [launch checklist](launch-checklist.md). Its automated checks A1–A11 are this iteration's bar.

**App** (`apps/mobile`):
- [x] **Release builds refuse test settings.** A non-https `API_BASE_URL` stops the app at startup. `DEV_WALLET_PRIVATE_KEY` is dropped at compile time, and the dev wallet isn't offered.
- [x] **Android settings:**
  - plain HTTP is refused outside the debug build type (network security config);
  - app data stays out of backups (`allowBackup`, data extraction rules).
- [x] **Signing and shrinking:**
  - release signing from the gitignored `android/key.properties`, falling back to the debug key with a warning;
  - R8 shrinking, with keep rules for our Kotlin and for Privy, and logcat `v`/`d`/`i` calls removed;
  - a test keeps logging out of the Dart code.
- [x] **The app checks what it signs.** Before every signature, the typed data must match the payment on screen and the app's settings: chain, USDC, recipient, amount, nonce and lifetime, plus the settlement contract when `SETTLEMENT_ADDRESS` is set.
- [x] **`tool/check_release.sh`** checks a built APK: A8 signing, A9 manifest and network security config, A10 test keys.
- [x] **Tap to pay:**
  - payments show in History;
  - a "This phone" switch revokes the phone's registration;
  - APPROVING requests show as sending.

**Backend** (`services/api`):
- [x] **Request limits:**
  - rate limits per route, by IP or by user (`RATE_LIMIT_*`), with `TRUST_PROXY` for a load balancer;
  - a body limit (`BODY_LIMIT_BYTES`) and security headers;
  - `{"error":"not_found"}` for unknown routes.
- [x] **Logs:** secrets and personal fields are redacted, and every logged error is scrubbed (keys, signatures, JWTs, QR payloads, RPC keys in URLs). Process handlers log crashes the same way.
- [x] **Production refuses test settings** (`NODE_ENV=production`):
  - the anvil chain and keys;
  - guessable secrets;
  - fixed rates, or rate limits turned off;
  - simulated partners and test destinations;
  - Xendit and MoonPay test keys, and MoonPay's sandbox widget;
  - a real partner without its webhook secret;
  - `MERCHANT_QR_ONLY=false`, or a `.local` `SIWE_DOMAIN`.
- [x] **Correctness fixes from the review:**
  - a `PaymentReceived` event must match its quote; otherwise it's never paid out and shows on `/ops` (`event_mismatch`);
  - a payment the chain shows paid is never FAILED, and a FAILED payment that turns out paid becomes PAID ([ADR 0007](adr/0007-chain-is-the-source-of-truth.md));
  - the payout and onramp workers page through work that's due, so old UNKNOWN payouts no longer block new ones;
  - expired onramp orders are re-checked for 24 hours;
  - approving a tap-to-pay request locks it (APPROVING) before relaying, so a cancel or expiry can't hide a transfer that happened ([ADR 0010](adr/0010-tap-to-pay.md));
  - a sender can send at most `P2P_DAILY_LIMIT_USDC` (2,000 USDC) by tap in 24 hours;
  - stuck transactions and long-SUBMITTED payments show on `/ops` ([ADR 0008](adr/0008-payout-outcomes-and-reconciliation.md)).
- [x] **Migrations:** `20261116000000_payment_event_mismatch` and `20261116100000_p2p_approving`.

**Docs:** the threat model, the key rotation runbook and the launch checklist. ADRs 0003 and 0007–0010 are updated.

**Result:**
- **Backend:** 352 tests pass, against Postgres, anvil and the Base Sepolia fork.
- **Contracts:** 47 tests pass; `forge fmt --check` and `forge lint` are clean again.
- **App:** 159 tests pass.
- **Release build:** it builds with R8. `tool/check_release.sh` passes A9 and A10. A8 also passes with a throwaway release key; with the debug-key fallback it fails, as it should.

**Not done yet:**
- **The owner's release key.** A8 passes only once `android/key.properties` names the real upload key.
- **Privy in a shrunk build on a phone.** R8 keeps Privy's classes, but nobody has signed in with a release build on a device yet.
- **Refusing mock KYC in production.** That waits for a real KYC adapter ("Before real money").
- **Per-person operator accounts.** [ADR 0008](adr/0008-payout-outcomes-and-reconciliation.md) planned them for this iteration; they move to "Before real money".
- **Crash reporting.** Logged errors are scrubbed, but choosing a tracker and shipping error-level logs to it is an ops step.
- **Smaller gaps**, listed under "Next":
  - rate-limit counters are kept per process;
  - concurrent payments can pass the 24-hour THB limit;
  - stuck transactions are shown, not replaced;
  - the JWT secret has no key ID or grace period.

## Iteration 11: Embedded wallet ✅ (needs a Privy app to try on a phone)

The rules are in [ADR 0003](adr/0003-embedded-non-custodial-wallet.md).

- [x] **`PrivyWalletService`** (`privy_flutter` 0.11.0, behind a `PrivyClient` interface):
  - sign-in with an email and a one-time code;
  - Privy creates the embedded wallet on first sign-in and restores the session on later launches;
  - signing out also logs out of Privy.
- [x] **Signing:** `personal_sign` for Sign-In with Ethereum, and `eth_signTypedData_v4` for both USDC authorisations. Only 65-byte signatures are accepted.
- [x] **`WalletSwitch` is the app's `WalletService`:**
  - Privy by default;
  - the dev wallet in debug builds only;
  - "Sign-in isn't set up" in a release build without the Privy IDs.
- [x] **Settings:** `PRIVY_APP_ID` and `PRIVY_CLIENT_ID` are dart-defines, never committed.
- [x] **Android:** `minSdk` 24 → 28 (Privy's Android library), plus a packaging exclude for a duplicated `META-INF` file.

**Result:** the sign-in screen, the wallet, the switch and session restore are tested against a fake Privy client. The "done when" (a new user signs up with email and completes a payment) needs a real Privy app, so it hasn't been checked on a device yet.

**Not done yet:**
- **A real sign-up and payment** on an emulator or phone, with the owner's Privy app and a funded wallet (the simulated onramp on anvil, or a faucet on Base Sepolia).
- **Google sign-in.** It needs an app URL scheme and Privy's `PrivyRedirectActivity`.
- **No fingerprint before a Privy signature.** This is an owner decision (below). Until then, the approve screen's fingerprint applies only to the dev wallet.

## Decisions for the owner

1. **minSdk 28 (Android 9 and later)** for Privy. It drops Android 7 and 8 phones. Accept it, or choose a wallet SDK that supports API 24.
2. **A biometric step before Privy signatures.** ADR 0010 promised a fingerprint for every approval, and with Privy it isn't asked.
   - **Recommended:** keep it. Gate each Privy signature behind `BiometricPrompt` with a `CryptoObject`, for example by opening a value sealed in the existing `KeyVault`, so the check can't be skipped the way a bare `local_auth` prompt can.
   - **Alternatives:** use Privy's MFA for signing, or drop the promise and update ADR 0010.
3. **Configure Privy for embedded EOA wallets**, not smart wallets. The backend checks sign-in offline and the contract uses USDC's `v, r, s` EIP-3009, so smart-wallet signatures would fail.
4. **Limits:**
   - `P2P_DAILY_LIMIT_USDC` (2,000 USDC) and the KYC tier limits are demo values;
   - `MERCHANT_QR_ONLY` is now forced on in production, while Xendit's rail pays only personal (tag 29) QRs, so production needs a partner that pays merchant QRs (Krungsri or a licensed partner).

## Next (engineering, not blocked on the owner)

- **CI** running checks A1–A6, A13 and A14 on every push. There's no CI today.
- **The Privy biometric gate**, if decision 2 says so.
- **An atomic 24-hour THB limit:** one transaction for the check and the insert, or a reservation at quote time (threat model WRK-15).
- **Stuck transactions:** replace-by-fee, and recovery from a gap in the relayer's nonces (WRK-6).
- **Stuck onramp orders on `/ops`** (WRK-10).
- **Sessions:** JWT key IDs with a grace period, shorter tokens with refresh, and server-side logout (API-1).
- **Phones:**
  - a device list in the app, to revoke a lost phone;
  - device key attestation (NFC-2) and Play Integrity (APP-2).
- **A payouts-only stop switch** (WRK-12).
- **Several instances:** a shared rate-limit store, and a setting to turn the workers off on extra API instances.
- **A salted merchant hash** (SC-9).
- **Google sign-in** with Privy.
- **A script that checks the mainnet deployment** (launch checklist A12).

## Before real money

- Thai legal opinion: the SEC's crypto-payment ban, the Payment Systems Act, and Decree No. 2 on offshore digital-asset services.
- A licensed partner: Krungsri corporate API (pays PromptPay IDs and bill-payment QRs) or a TouristDigiPay exchange and e-money operator.
- **A real KYC provider** (Sumsub or Onfido, passport and visa), with production refusing the mock, and verified names for tap to pay.
- **AML:** sanctions and on-chain screening, transaction monitoring, and a review of tap to pay (USDC between users).
- **Keys:**
  - the contract admin on a multisig, and the pauser on a separate key;
  - the quote signer and relayer in a KMS;
  - relaying split from settling and refunding;
  - partner keys in a secret manager.
- **Operators:** per-person accounts (SSO with MFA), four-eyes for mark-paid and approve-refund, and `/ops` behind a VPN or allowlist.
- **Monitoring that pages someone:** `/ops/api/health`, contract role and treasury events, and error-level logs shipped to a tracker.
- **Hosting:** TLS, backups, and launch checklist A12–A16.
- A decision on refunds to USDC-blacklisted payers ([ADR 0006](adr/0006-immutable-settlement-contract.md)).
- A contract audit.
- A controlled 1-baht live payment to an allowlisted merchant.

The [launch checklist](launch-checklist.md) breaks these down into checks and sign-offs.

## After the demo (product)

- USDT support (Permit2 or ERC-4337 paymaster)
- Partner debit card
- Disputes ("merchant not paid"), spending limits and wallet recovery screens
- Invoices, income statements and CSV export
- Bank-card tap as an alternative to phone-to-phone (only after a PCI review)
- More countries: Indonesia (QRIS), Vietnam (VietQR), then India via the offshore + prepaid-wallet structure

## Steps that need the project owner

- **Android:** install cmdline-tools in Android Studio's SDK Manager and accept the SDK licences (`flutter doctor --android-licenses`).
- **Release key:** create the upload key outside the repo, keep it and its passwords in the team vault, and write `apps/mobile/android/key.properties` ([apps/mobile/README.md](../apps/mobile/README.md#signing)). For the store: a Play Console account with MFA and Play App Signing.
- **Privy** (iteration 11):
  - a dashboard app with email login and embedded EOA wallets;
  - an app client that allows `com.globalpay.globalpay`;
  - its App ID and Client ID, passed at build time as `PRIVY_APP_ID` and `PRIVY_CLIENT_ID`.
- **Xendit:** a test account, its secret key and callback token (iteration 6, run in iteration 7).
- **Faucets:** Base Sepolia ETH (about 0.01 for the deployer and 0.02 for the relayer) and 10+ Circle test USDC for the test payer (iteration 7).
- **MoonPay:** a sandbox account with its publishable, secret and webhook keys, and the Sepolia token it delivers (iteration 8).
- **Firebase:** a project with an Android app (for the `FIREBASE_*` dart-defines) and a service-account key for the backend (iteration 9).
- **Two NFC Android phones** with strong biometrics, for the tap test (iteration 9).
- **A public host** for the backend with TLS, so Xendit and MoonPay can reach the webhooks (a tunnel works for testing).
- **Optional:** an Etherscan API key for contract verification; an error tracker account for the backend's logs.
- **Business and legal:** the items under "Before real money", and the decisions above.
