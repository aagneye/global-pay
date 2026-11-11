# ADR 0005: Partners behind ports, simulated adapters for the demo

- **Status:** Accepted
- **Date:** 2026-11-12

## Context

The regulated parts of the product (crypto-to-baht conversion, holding baht, PromptPay payout, KYC) depend on licensed Thai partners that aren't signed yet. The demo still has to run end to end.

## Decision

Every external dependency is an interface in `services/api/src/ports/`, with adapters in `src/adapters/`:

| Port | Demo adapter | Production candidates |
|---|---|---|
| `KycProvider` | `MockKycProvider` (auto-approve, tiered) | Sumsub, Onfido |
| `RateProvider` | Public USDC/THB feed with configurable spread | Partner exchange's quote API |
| `PayoutProvider` | `SimulatedPromptPayProvider` (delay and failure rate are configurable) | Licensed Thai e-money operator |
| `SettlementGateway` | viem against anvil or Base Sepolia | Same, on Base mainnet |
| `QuoteSigner` | viem local account | KMS-backed signer |

## Consequences

- Core logic (quotes, payments, workers) never imports a partner SDK.
- The simulated payout can be forced to fail, which exercises the refund path.
- The demo proves the product flow, not the partner integrations or licensing. Those remain the main business risk.
