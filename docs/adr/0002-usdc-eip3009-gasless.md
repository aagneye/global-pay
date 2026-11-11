# ADR 0002: USDC with EIP-3009 for gasless payments

- **Status:** Accepted
- **Date:** 2026-11-12

## Context

Users shouldn't need to hold ETH to pay gas, and a payment must be a single tap. The usual `approve` + `transferFrom` takes two transactions and needs ETH. ERC-4337 paymasters solve the gas problem but add a bundler and paymaster to run.

## Decision

- The user signs a USDC **`ReceiveWithAuthorization`** (EIP-3009) with `to` = settlement contract, `value` = quote amount, `nonce = quoteId` and `validBefore = quote expiry`.
- The backend relayer submits `GlobalPaySettlement.pay()` and pays the gas.
- The contract calls `receiveWithAuthorization`, which only the recipient can call, so the signed authorisation can't be front-run.

## Alternatives considered

- **`approve` + `transferFrom`:** two transactions, and the user needs ETH.
- **EIP-2612 `permit` + `transferFrom`:** gasless, but the permit and the transfer are separate steps, and permit isn't tied to a single quote.
- **ERC-4337 smart accounts with a paymaster:** flexible, but more infrastructure. Revisit for USDT and batching.

## Consequences

- Each authorisation is bound to exactly one quote and expires with it.
- The token's EIP-712 domain must be read from the chain (`name()`, `version()`), because it differs per network.
- USDT doesn't support EIP-3009, so it will need Permit2 or ERC-4337.
- GlobalPay pays all gas, so the fee model must cover it. On Base this is a fraction of a cent.
