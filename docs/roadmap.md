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

## Iteration 2: Settlement contract

1. Install Foundry (`foundryup` in Git Bash, or WSL as a fallback) and add the libraries: `forge install foundry-rs/forge-std OpenZeppelin/openzeppelin-contracts`.
2. Implement `GlobalPaySettlement`:
   - roles, `Pausable`, `ReentrancyGuard`, EIP-712 quote verification
   - `pay` via `receiveWithAuthorization`, plus `markSettled` and `refund`
   - token allowlist and treasury
3. Implement `test/mocks/MockUSDC3009.sol`.
4. Tests:
   - happy path
   - failure cases: expired quote, replayed quote or nonce, wrong signer, payer or amount mismatch, token not allowed, paused
   - settle and refund only from `Paid`; role checks
   - fuzz tests on amounts
5. Write `script/Deploy.s.sol` to deploy the contract, grant roles and allowlist USDC.

**Done when:** `forge test` passes and coverage has been reviewed.

## Iteration 3: Backend core

1. Prisma client with `@prisma/adapter-pg`, the first migration, and repositories.
2. PromptPay parser and builder in `src/lib/promptpay`, tested against the shared vectors. Make `npm run qr:make` print test QRs.
3. Rate provider (public feed) with spread. Quote maths in `bigint`, with tests.
4. EIP-712 quote signer (viem).
5. Sign-In with Ethereum: nonce, verify, JWT, and an auth hook on protected routes.
6. Mock KYC with tiers and limits.
7. OpenAPI spec through `@fastify/swagger`, served at `/docs`.

**Done when:** unit tests pass, and `POST /quotes` returns a signed quote locally.

## Iteration 4: Settlement loop on a local chain

1. viem `SettlementGateway`: `pay`, `markSettled`, `refund`, receipts, logs, balances, and reading the token's EIP-712 domain.
2. Relayer with nonce management, retries and receipt waiting.
3. Indexer with a saved block cursor, confirmation depth, and handling of repeated events.
4. Payout worker with `SimulatedPromptPayProvider`, which then settles or refunds.
5. Integration test on anvil: deploy mock USDC and the settlement contract, then run the full flow from TypeScript for both the settle and refund paths.

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
