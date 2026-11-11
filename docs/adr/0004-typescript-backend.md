# ADR 0004: TypeScript backend

- **Status:** Accepted
- **Date:** 2026-11-12

## Context

The backend signs quotes, relays transactions, indexes chain events, and talks to payment and KYC partners. Ethereum tooling and payment-partner SDKs are strongest in TypeScript.

## Decision

- **Node 22 + Fastify** for HTTP, **zod** for validation, **viem** for the chain, **Prisma + Postgres** for storage, **vitest** for tests.
- The backend runs as its own service. The Flutter app calls it over HTTPS/JSON, with a Dart client generated from the backend's OpenAPI spec.

## Consequences

- The project uses two languages (Dart and TypeScript). Two things keep them in sync: the generated API client, and the shared test vectors in `packages/fixtures`.
- viem gives first-class EIP-712 signing, ABI typing and log decoding.
- Prisma is pinned to 7.x (stable), which configures the database URL in `prisma.config.ts`.
