# ADR 0006: Immutable settlement contract, with pausing split between roles

- **Status:** Accepted
- **Date:** 2026-11-12

## Context

`GlobalPaySettlement` holds user funds between `pay` and `markSettled`/`refund`. An upgradeable proxy would let us fix bugs in place. It would also let whoever controls upgrades change the rules for funds already in the contract, and it adds storage-layout risk.

Funds stay in the contract only for the seconds to minutes a payout takes, so a fresh deployment is a cheap way to ship a change.

## Decision

- **No proxy.** The contract is immutable. A change means deploying a new contract: the backend points new quotes at it, and the old contract resolves its remaining payments.
- **Pausing is split between roles.**
  - `PAUSER_ROLE` can `pause()`, which blocks new payments.
  - Only `DEFAULT_ADMIN_ROLE` can `unpause()`, so a pauser key can stop payments but can't resume them after an incident.
- **Settle and refund ignore pause**, so in-flight funds can always be resolved.
- **Received-amount check:** `pay` checks that the contract's balance rose by exactly the quoted amount, protecting against a misconfigured or non-standard token.

## Consequences

- Deploying a new contract means updating the backend's `SETTLEMENT_ADDRESS` and re-granting roles. `Deploy.s.sol` does the role setup.
- No one can change the rules for funds that are already in the contract.
- The contract can't sweep stuck funds. If USDC blacklists a payer, their `refund` will revert. That's accepted for the demo, and must be revisited before mainnet.
