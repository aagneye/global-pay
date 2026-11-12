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

## Iteration 4: Settlement loop on a local chain

1. viem `SettlementGateway`: `pay`, `markSettled`, `refund`, receipts, logs, balances, and reading the token's EIP-712 domain.
2. Relayer with nonce management, retries and receipt waiting.
3. Indexer with a saved block cursor, confirmation depth, and handling of repeated events.
4. Payout worker with `SimulatedPromptPayProvider`, which then settles or refunds.
5. Integration test on anvil: deploy mock USDC and the settlement contract (with `script/DeployLocal.s.sol` or the compiled artifacts), then run the full flow from TypeScript for both the settle and refund paths.

**Done when:** the integration test passes for both paths.

## Iteration 5: Mobile app

1. Add packages: `mobile_scanner`, `qr_flutter`, `flutter_secure_storage`, `freezed` / `json_serializable` + `build_runner`, and an EVM signing library (chosen after checking pub.dev).
2. Implement `DevWalletService`: a local key in secure storage, with EIP-191 and EIP-712 signing.
3. Generate the Dart API client from the backend's OpenAPI spec into `lib/data/api/generated/`.
4. Sign-In with Ethereum login and the mock KYC screen.
5. Dart PromptPay parser, tested against the shared vectors.
6. Screens:
   - Scan → Confirm (60s countdown) → Sign → Status (polling)
   - Home (balance), Receive (address QR + EIP-681 link), History

**Done when:** the full flow works on the Android emulator against the local backend and anvil.

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
