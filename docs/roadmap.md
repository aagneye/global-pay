# Roadmap: testnet demo

The demo is built in seven iterations. Each one ends with its tests passing and is committed as small, atomic commits.

**End goal:** in the Flutter app, scan a PromptPay QR, pay with test USDC on Base Sepolia, and watch a simulated baht payout settle, or refund if the payout fails.

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

## Iteration 6: Base Sepolia

1. Generate testnet keys and fund the deployer and relayer with Base Sepolia ETH. Then deploy the contract and verify it on Basescan.
2. Point the backend at Base Sepolia and Circle's test USDC, and fund the app wallet from Circle's faucet.
3. End-to-end test: a 100 THB payment settles, and a forced payout failure refunds.

**Done when:** both paths are visible on Basescan.

## Iteration 7: Embedded wallet

1. Create a Privy app (you do this), then implement `PrivyWalletService` with email/Google login and typed-data signing. Use Web3Auth if Privy doesn't fit.
2. Make it the default `WalletService`, and keep `DevWalletService` for tests.

**Done when:** a new user can sign up with email and complete a payment.

## After the demo (product)

- USDT support (Permit2 or ERC-4337 paymaster)
- Partner debit card
- Invoices, income statements and CSV export
- Real Thai partners and entry into the sandbox
- Production key management (KMS, multisig admin), monitoring, and a contract audit
- More countries: Indonesia (QRIS), Vietnam (VietQR), then India via the offshore + prepaid-wallet structure

## Steps that need the project owner

- **Android:** install cmdline-tools in Android Studio's SDK Manager and accept the SDK licences (`flutter doctor --android-licenses`).
- **Privy:** create a dashboard account and app ID (iteration 7).
- **Faucets:** Base Sepolia ETH and Circle test USDC (iteration 6).
- **Optional:** an Etherscan API key for contract verification.
