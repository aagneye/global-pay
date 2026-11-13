# services/api

The GlobalPay backend (TypeScript, Node 22). It does five jobs:
- signs quotes for PromptPay QR payments;
- relays the user's signed USDC authorisation to the settlement contract;
- indexes on-chain payment events;
- drives the baht payout (simulated, or Xendit's sandbox);
- settles or refunds each payment.

Stack: Fastify, zod (validation and OpenAPI), viem, Prisma 7 (Postgres), jose (JWT), vitest.

## Status

Iterations 3 (backend core), 4 (settlement loop) and 6 (payout confirmation and operations) are done. These work:

| Route | What it does |
|---|---|
| `POST /auth/nonce`, `POST /auth/verify` | Sign-In with Ethereum, then a JWT |
| `POST /kyc/start`, `GET /kyc/status` | Mock KYC: approved at tier 1, with spending limits |
| `POST /quotes` | Parses a PromptPay QR, checks limits, prices it at the live rate plus the spread, and returns an EIP-712-signed quote plus the USDC authorisation for the wallet to sign |
| `POST /payments` | Checks the user's signed USDC authorisation, relays `pay()`, and returns `202 SUBMITTED` |
| `GET /payments/:id`, `GET /me/payments` | Status (SUBMITTED → PAID → PAYOUT_PENDING → SETTLED / REFUNDED, or FAILED) with explorer links, plus the payout's status and bank reference |
| `GET /me/balance` | The wallet's USDC balance, read from the chain |
| `GET /docs` | OpenAPI docs (spec at `/docs/json`) |
| `POST /webhooks/payouts/:partner` | Partner status webhooks: token checked, then the payout is re-fetched before anything changes |
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
                      auth, kyc, quotes, payments, account, ops (operator console)
  modules/payouts/    PayoutTracker (partner answers → payout status, shared by worker, webhook and ops)
  workers/            indexer (chain events) and payout worker (pay out, then settle or refund)
  shared/             errors, zod schemas, auth hook
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

## Conventions

- **Money:** integers in minor units (`bigint`). Over HTTP, amounts are integer strings (`"10000"` = 100.00 THB).
- **Rates:** fixed-point `rateE8`, meaning fiat major units per 1 token × 1e8.
- **Rounding:** token amounts round up, so GlobalPay never receives less than it pays out.
- **Hex values:** addresses and hashes are 0x-prefixed. Store them lowercase; return addresses checksummed.
- **Errors:** `{ "error": "<code>", "message": "…" }` with a stable code, e.g. `kyc_required`, `invalid_qr`.
- **Partners:** a new partner is a new adapter for an existing port.
