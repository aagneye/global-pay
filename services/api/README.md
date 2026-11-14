# services/api

The GlobalPay backend (TypeScript, Node 22). It does five jobs:
- signs quotes for PromptPay QR payments;
- relays the user's signed USDC authorisation to the settlement contract;
- indexes on-chain payment events;
- drives the baht payout (simulated, or Xendit's sandbox);
- settles or refunds each payment.

Stack: Fastify, zod (validation and OpenAPI), viem, Prisma 7 (Postgres), jose (JWT), vitest.

## Status

Iterations 3 (backend core), 4 (settlement loop), 6 (payout confirmation and operations), 8 (Add money) and 9 (tap to pay) are done. These work:

| Route | What it does |
|---|---|
| `POST /auth/nonce`, `POST /auth/verify` | Sign-In with Ethereum, then a JWT |
| `POST /kyc/start`, `GET /kyc/status` | Mock KYC: approved at tier 1, with spending limits |
| `POST /quotes` | Parses a PromptPay QR, checks limits, prices it at the live rate plus the spread, and returns an EIP-712-signed quote plus the USDC authorisation for the wallet to sign |
| `POST /payments` | Checks the user's signed USDC authorisation, relays `pay()`, and returns `202 SUBMITTED` |
| `GET /payments/:id`, `GET /me/payments` | Status (SUBMITTED → PAID → PAYOUT_PENDING → SETTLED / REFUNDED, or FAILED) with explorer links, plus the payout's status and bank reference |
| `GET /me/balance` | The wallet's USDC balance, read from the chain |
| `POST /onramp/orders`, `GET /onramp/orders[/:id]` | Add money: a signed MoonPay checkout for the user's own wallet; COMPLETED only once the USDC is proved on-chain |
| `GET /me/deposits` | USDC that arrived from outside, linked to the Add-money order it completed |
| `PUT /me/profile`, `POST /devices` | The name people see when paying you; a phone's hardware key and push token for tap to pay |
| `POST /p2p/requests`, `.../tap`, `.../claim`, `.../authorization`, `.../approve`, `GET /p2p/incoming` | Tap to pay: the receiver asks, a tap (P-256 signature over a one-time challenge) or QR identifies the payer, who approves a USDC transfer that the backend relays |
| `GET /docs` | OpenAPI docs (spec at `/docs/json`) |
| `POST /webhooks/payouts/:partner` | Partner status webhooks: token checked, then the payout is re-fetched before anything changes |
| `POST /webhooks/onramp/:partner` | MoonPay webhooks: signature over the raw body and its age checked, then the order is re-fetched |
| `/ops`, `/ops/api/*` | Operator console (with `OPS_API_TOKEN`): exceptions, health, re-check, mark paid, approve refund |

In the background, the **indexer** marks payments PAID from on-chain events. The **payout worker** then pays the merchant through the payout partner and settles or refunds on-chain. An unclear payout outcome is never settled or refunded automatically; it waits for the partner or an operator ([ADR 0008](../../docs/adr/0008-payout-outcomes-and-reconciliation.md)). See [docs/architecture.md](../../docs/architecture.md#settlement-loop) and [docs/roadmap.md](../../docs/roadmap.md).

## Layout

```
src/
  main.ts             process entry: env → container → app → workers → listen
  app.ts              Fastify app: zod schemas, OpenAPI, auth hook, error handling, routes
  container.ts        composition root: picks adapters, wires services and workers
  config/env.ts       validated configuration (see .env.example)
  domain/             pure types and rules: money, pricing, quote, payment state machine, KYC limits
  ports/              interfaces to the outside: repositories, KYC, rates, payouts, settlement contract, quote signer
  adapters/           port implementations:
    db/               Prisma repositories
    chain/            viem quote signer, settlement gateway and relayer
    rates/            Coinbase public feed, fixed rate
    kyc/              mock KYC
    payouts/          simulated PromptPay partner, Xendit payouts (sandbox)
  lib/promptpay/      EMVCo PromptPay parser and builder (shared vectors in packages/fixtures)
  lib/typed-data.ts   EIP-712 types shared with the contracts (Quote, ReceiveWithAuthorization)
  modules/<feature>/  routes.ts (HTTP schemas) and service.ts (use case):
                      auth, kyc, quotes, payments, account, ops (operator console), onramp (Add money),
                      p2p (tap to pay)
  modules/payouts/    PayoutTracker (partner answers → payout status, shared by worker, webhook and ops)
  workers/            indexer (chain events), payout worker (pay out, then settle or refund),
                      onramp worker (Add-money orders), deposit watcher (incoming USDC),
                      p2p worker (tap-to-pay expiry and receipts)
  shared/             errors, zod schemas, auth hook, rate limits, log redaction and error scrubbing
  generated/prisma/   Prisma client (generated on npm install, gitignored)
prisma/               schema and migrations
scripts/              developer tools (demo QR generator, Xendit sandbox check, OpenAPI export)
test/                 vitest tests; test/support has the test app, in-memory repositories and anvil constants
```

Architecture rules:
- `domain/` imports nothing outside itself except `shared/errors`.
- Services depend on `ports/`, never on `adapters/`.
- Only `container.ts` chooses adapters.

## Commands

```bash
npm install              # also generates the Prisma client
cp .env.example .env     # PowerShell: Copy-Item .env.example .env, then set JWT_SECRET
npm run db:migrate       # apply migrations to DATABASE_URL
npm run dev              # http://localhost:3000/docs
npm run typecheck
npm test
npm run qr:make          # print demo PromptPay QRs; npm run qr:make -- 250.50 for another amount
npm run openapi          # after changing a route: rewrite packages/openapi/openapi.json
```

To change the schema: edit `prisma/schema.prisma`, then run `npm run db:migrate:dev -- --name <change>`.

### Database tests

`test/db/` checks the Prisma repositories against a real Postgres. The tests are skipped unless `TEST_DATABASE_URL` is set, and they **empty every table**, so point it at a throwaway database:

```bash
TEST_DATABASE_URL=postgresql://globalpay:globalpay@localhost:5432/globalpay_test npm test
```

Apply the migrations to that database first (`DATABASE_URL=<same url> npm run db:migrate`). With a database set, test files run one at a time.

### Chain integration test

`test/integration/` runs the whole settlement loop on a real local chain:
1. It starts its own anvil on a free port.
2. It deploys with `contracts/script/DeployLocal.s.sol`.
3. It pays, settles and refunds through the HTTP API and the real viem gateway.

It needs Foundry. It finds `anvil` and `forge` in `$FOUNDRY_BIN`, then `~/.foundry/bin`, then PATH, and skips itself if they aren't there. It uses Postgres when `TEST_DATABASE_URL` is set, and memory otherwise.

## Try a payment locally

1. Start anvil and deploy the contracts ([contracts/README.md](../../contracts/README.md#local-chain-anvil)).
2. In `.env`, use the "Local chain instead" block from `.env.example`.
3. `npm run dev`, then open `http://localhost:3000/docs`.
4. The flow is:
   1. `POST /auth/nonce` with your wallet address;
   2. sign the returned `message` (`personal_sign`);
   3. `POST /auth/verify` returns a token;
   4. `POST /kyc/start`, then `GET /kyc/status`;
   5. `POST /quotes` with a QR from `npm run qr:make`;
   6. sign `authorizationToSign` (`eth_signTypedData_v4`) with the same wallet;
   7. `POST /payments`;
   8. poll `GET /payments/{id}` until it's SETTLED.
5. With `INDEXER_CONFIRMATIONS=0` (anvil only mines when there's a transaction), it settles in a few seconds. Set `PAYOUT_FAILURE_RATE=1` to see a refund.

## Payouts and the operator console

`PAYOUT_PROVIDER` picks the partner:
- **`simulated`** (the default): no money moves.
  - `PAYOUT_FAILURE_RATE=1` forces refunds.
  - `PAYOUT_UNKNOWN_RATE=1` makes every outcome unclear, so you can try the operator flow.
- **`xendit`**: Xendit payouts, with **test-mode keys only**.
  1. Run `npm run xendit:sandbox` with `XENDIT_SECRET_KEY` set. It shows your THB balance and payout channels.
  2. Set `XENDIT_PROMPTPAY_CHANNEL`, or map the demo QRs to test accounts with `PAYOUT_TEST_DESTINATIONS`.
  3. `npm run xendit:sandbox -- pay <channel> <account> <amount>` sends one test payout through the adapter.
  4. For webhooks, expose the API (e.g. with a tunnel), then set `<url>/webhooks/payouts/xendit` and `XENDIT_CALLBACK_TOKEN` in the Xendit dashboard.

Set `OPS_API_TOKEN` (32+ characters) and open `http://localhost:3000/ops`. Enter your name and the token. The page lists everything that needs a person:
- unclear (UNKNOWN) or reversed payouts;
- stuck payments;
- partner errors;
- settlements that keep failing.

It also shows the relayer's gas and the payout float. Its actions (re-check, mark paid with a bank reference, approve refund) each re-check the partner first, and each is recorded in the audit log ([ADR 0008](../../docs/adr/0008-payout-outcomes-and-reconciliation.md)).

## Add money

`ONRAMP_PROVIDER` picks the onramp:
- **`simulated`** (the default): `POST /onramp/orders` returns `/onramp/simulator/<id>`, a page with "Pay with test card" and "Decline". Paying mints mock USDC to the user's wallet on anvil. The order completes once the onramp worker sees the transfer on-chain, and the deposit watcher lists it under `/me/deposits`.
- **`moonpay`**: set `MOONPAY_PUBLISHABLE_KEY`, `MOONPAY_SECRET_KEY` and `MOONPAY_WEBHOOK_KEY`, using sandbox keys.
  - **Delivery chain:** the sandbox delivers on Ethereum Sepolia, so point the `ONRAMP_RPC_URL`, `ONRAMP_CHAIN_ID`, `ONRAMP_TOKEN_ADDRESS` and `ONRAMP_EXPLORER_URL` settings there.
  - **Webhooks:** register `<public URL>/webhooks/onramp/moonpay` in MoonPay's dashboard.

An order is COMPLETED only once a confirmed transfer of the reported amount reaches the user's wallet, and each transfer completes one order ([ADR 0009](../../docs/adr/0009-add-money-proved-on-chain.md)).

## Tap to pay

`POST /p2p/requests` (the receiver) returns a one-time `challenge`.

1. **Tap:** the receiver's phone sends the challenge to the payer's phone over NFC, and forwards the answer to `POST /p2p/requests/:id/tap`. The answer is the device ID and a P-256 signature over `"GLOBALPAY-TAP-1"` followed by the challenge.
2. **Push:** the payer gets a push carrying only the request ID, or sees the request in `GET /p2p/incoming`.
3. **Approve:** the payer signs the transfer from `.../authorization`, an EIP-712 `TransferWithAuthorization` built from the stored request, and sends it to `.../approve`.
4. **Relay:** the backend checks the signature against the stored request and relays the transfer. The P2P worker records COMPLETED once it's mined.

Push needs `FCM_SERVICE_ACCOUNT_FILE`; without it the apps poll. The rules are in [ADR 0010](../../docs/adr/0010-tap-to-pay.md).

## Hardening

**Rate limits** (`src/shared/rate-limits.ts`, `RATE_LIMIT_*` settings). Every route has a limit per window (`RATE_LIMIT_WINDOW_MS`, a minute by default):

| Routes | Keyed by | Setting (default) |
|---|---|---|
| `POST /auth/nonce`, `POST /auth/verify` | IP | `RATE_LIMIT_AUTH_MAX` (30) |
| `POST /quotes`, `POST /payments` | signed-in user, else IP | `RATE_LIMIT_PAYMENTS_MAX` (30) |
| `POST /onramp/orders` | signed-in user, else IP | `RATE_LIMIT_ONRAMP_MAX` (10) |
| `POST /p2p/requests`, `.../tap`, `.../claim`, `.../approve` | signed-in user, else IP | `RATE_LIMIT_P2P_MAX` (30) |
| `POST /devices` | signed-in user, else IP | `RATE_LIMIT_DEVICES_MAX` (10) |
| `POST /webhooks/*` | IP | `RATE_LIMIT_WEBHOOKS_MAX` (1200) |
| `/ops/api/*` (wrong tokens count too) | IP | `RATE_LIMIT_OPS_MAX` (120) |
| everything else, including unknown URLs (shared budget) | IP | `RATE_LIMIT_MAX` (600) |

- Each route in the table has its own counter. `/health` is never limited.
- Over the limit, the API answers `429 {"error":"rate_limited","message":"…"}` with `Retry-After` (seconds). Every response carries `X-RateLimit-Limit`, `-Remaining` and `-Reset`.
- Counters live in memory, per process. Run several instances and each one counts on its own; a shared store (Redis) is the step after that.
- Behind a load balancer, set `TRUST_PROXY` (e.g. `1`), or every client shares the balancer's IP.

**Log redaction** (`src/shared/redact.ts`). Logs never contain these, wherever they appear in a log entry (top level, or up to two levels down, e.g. `req.headers.authorization` or `body.signature`). Each is replaced with `[Redacted]`:
- headers: `authorization`, `cookie`, `set-cookie`, `x-ops-token`, `x-callback-token`, `moonpay-signature-v2`;
- fields: `signature`, `qrPayload`, `fcmToken`, `publicKey`, `displayName`, `challenge`, tokens, passwords, secret and private keys, bank account details and email.

Fastify's request logs only show the method, URL and status anyway; redaction covers code that logs more. Don't put secrets in URLs.

**Error reporting without personal data** (`src/shared/redact.ts`, `src/shared/logging.ts`). Logs are the error report: ship entries at level 50+ (error, fatal) from stdout to whichever error tracker you use. Before anything is written:
- every logged error (`err`) is scrubbed in full: secret fields at any depth, its message, stack and causes;
- in that text and in log messages, these are replaced: 32+ bytes of hex (keys, signatures, hashes), JWTs, `Bearer` values, PromptPay QR payloads, and credentials in URLs (`user:password@`, `?key=`, an RPC provider's `/v2/<key>`). 20-byte addresses stay, to follow a payment.

`src/main.ts` installs process handlers. An uncaught exception is logged (scrubbed), then the process exits with 1 for the supervisor to restart it; the workers resume from the database and the chain. An unhandled promise rejection is logged and the server keeps running.

**Production checks** (`src/config/env.ts`). With `NODE_ENV=production` the server refuses to start with:
- the local anvil chain (`CHAIN_ID` or `ONRAMP_CHAIN_ID` 31337), or any of anvil's ten public keys as `QUOTE_SIGNER_PRIVATE_KEY` or `RELAYER_PRIVATE_KEY`;
- a guessable `JWT_SECRET` or `OPS_API_TOKEN` (fewer than 10 distinct characters, or words like "secret" or "change me"), or the same value for both;
- `RATE_SOURCE=fixed` or `RATE_LIMIT_ENABLED=false`;
- simulated partners, `PAYOUT_TEST_DESTINATIONS`, Xendit test-mode keys (`xnd_development_…`), MoonPay sandbox keys (`pk_test_`, `sk_test_`, `wk_test_`) or MoonPay's sandbox widget URL.

## Conventions

- **Money:** integers in minor units (`bigint`). Over HTTP, amounts are integer strings (`"10000"` = 100.00 THB).
- **Rates:** fixed-point `rateE8`, meaning fiat major units per 1 token × 1e8.
- **Rounding:** token amounts round up, so GlobalPay never receives less than it pays out.
- **Hex values:** addresses and hashes are 0x-prefixed. Store them lowercase; return addresses checksummed.
- **Errors:** `{ "error": "<code>", "message": "…" }` with a stable code, e.g. `kyc_required`, `invalid_qr`, `rate_limited`, `not_found`.
- **Partners:** a new partner is a new adapter for an existing port.
