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

## Iteration 8: Add money

1. **MoonPay** onramp (sandbox first): the backend creates an order and a signed MoonPay link for the user's own address; the app opens it in a browser tab.
2. Status from signed webhooks and polling. "Received" only after the USDC transfer to the user's address is confirmed on-chain.
3. "Deposit from another wallet": the receive screen plus a watcher for incoming USDC, shown in history.

**Done when:** a sandbox order completes end to end, and a deposit on Base Sepolia shows in the app.

## Iteration 9: Tap to pay

1. Person-to-person USDC payments: the receiver enters an amount, the sender holds their phone to the receiver's phone (NFC), or scans a QR as a fallback.
2. The sender's phone proves who it is with a hardware-backed key; the backend sends a push notification carrying only the request ID.
3. The sender sees the recipient's verified name and the amount, approves with their fingerprint, and signs a gasless USDC transfer that the backend relays.
4. Requests are stored, expire after 2 minutes, and are rate-limited.

**Done when:** two Android phones complete a tap payment on Base Sepolia, with the push arriving while the app is closed.

## Iteration 10: Production hardening

1. App: release builds without the dev wallet, test keys or plain HTTP; release signing; code shrinking.
2. Backend: rate limits, log redaction, webhook checks, key rotation, crash reporting without personal data.
3. A threat model, a key-rotation runbook and a launch checklist.

**Done when:** a signed release build passes the checklist's automated checks.

## Iteration 11: Embedded wallet

1. Create a Privy app (you do this), then implement `PrivyWalletService` with email/Google login and typed-data signing. Use Web3Auth if Privy doesn't fit.
2. Make it the default `WalletService`, and keep `DevWalletService` for tests.

**Done when:** a new user can sign up with email and complete a payment.

## Before real money

- Thai legal opinion: the SEC's crypto-payment ban, the Payment Systems Act, and Decree No. 2 on offshore digital-asset services.
- A licensed partner: Krungsri corporate API (pays PromptPay IDs and bill-payment QRs) or a TouristDigiPay exchange and e-money operator.
- Contract audit, production key management (KMS, multisig admin), monitoring.
- A controlled 1-baht live payment to an allowlisted merchant.

## After the demo (product)

- USDT support (Permit2 or ERC-4337 paymaster)
- Partner debit card
- Disputes ("merchant not paid"), spending limits and wallet recovery screens
- Invoices, income statements and CSV export
- Bank-card tap as an alternative to phone-to-phone (only after a PCI review)
- More countries: Indonesia (QRIS), Vietnam (VietQR), then India via the offshore + prepaid-wallet structure

## Steps that need the project owner

- **Android:** install cmdline-tools in Android Studio's SDK Manager and accept the SDK licences (`flutter doctor --android-licenses`).
- **Xendit:** a test account and its secret key and callback token (iteration 6).
- **Faucets:** Base Sepolia ETH and Circle test USDC (iteration 7).
- **MoonPay:** a sandbox account (iteration 8).
- **Firebase:** a project and the Android `google-services.json` (iteration 9).
- **Privy:** a dashboard account and app ID (iteration 11).
- **Optional:** an Etherscan API key for contract verification.
- **Business and legal:** the items under "Before real money".
