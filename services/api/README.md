# services/api

The GlobalPay backend (TypeScript, Node 22). It does five jobs:
- signs quotes for PromptPay QR payments;
- relays the user's signed USDC authorisation to the settlement contract;
- indexes on-chain payment events;
- drives the (simulated) baht payout;
- settles or refunds each payment.

Stack: Fastify, zod, viem, Prisma 7 (Postgres), vitest.

## Layout

```
src/
  main.ts             process entry: env → container → app → workers → listen
  app.ts              Fastify app factory, error handling, route registration
  container.ts        composition root: picks adapters, wires services and workers
  config/env.ts       validated configuration (see .env.example)
  domain/             pure types and rules: money, quote, payment state machine, user limits
  ports/              interfaces to the outside: KYC, rates, payouts, settlement contract, quote signer
  adapters/           port implementations: mock KYC, rate feed, simulated PromptPay, viem chain
  lib/promptpay/      EMVCo PromptPay parser and builder (shared vectors in packages/fixtures)
  modules/<feature>/  routes.ts (HTTP + validation) and service.ts (use case):
                      auth, kyc, quotes, payments, account
  workers/            indexer (chain events) and payout worker (pay out, then settle or refund)
  shared/             errors, zod schemas, auth helper
prisma/schema.prisma  data model
scripts/              developer tools (demo QR generator)
test/                 vitest tests
```

Architecture rules:
- `domain/` imports nothing outside itself except `shared/errors`.
- Services depend on `ports/`, never on `adapters/`.
- Only `container.ts` chooses adapters.

## Commands

```bash
npm install
cp .env.example .env     # PowerShell: Copy-Item .env.example .env, then set JWT_SECRET
npm run dev              # http://localhost:3000/health
npm run typecheck
npm test
npm run prisma:validate
```

## Status

Iteration 1 is a skeleton. Here's what works today:
- `/health` returns ok.
- Request validation rejects bad input with 400.
- Every other route returns `501 not_implemented` with the iteration that will build it.

See [docs/roadmap.md](../../docs/roadmap.md) for the build order.

## Conventions

- **Money:** integers in minor units (`bigint`). Over HTTP, amounts are integer strings (`"10000"` = 100.00 THB).
- **Rates:** fixed-point `rateE8`, meaning fiat major units per 1 token × 1e8.
- **Hex values:** addresses and hashes are 0x-prefixed. Store them lowercase.
- **Partners:** a new partner is a new adapter for an existing port.
