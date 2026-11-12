# ADR 0007: The chain is the source of truth for payments; every worker step can be repeated

- **Status:** Accepted
- **Date:** 2026-11-12

## Context

A payment spans the API, the chain and the payout partner. Any of them can be slow, and the backend can crash between any two steps:
- after sending `pay()` but before saving the hash;
- after the partner paid but before `markSettled`;
- after `markSettled` was mined but before the database knew.

Users' money is in the contract during that window, so nothing may be paid twice, and nothing may be lost or stuck.

## Decision

- **The chain decides.**
  - A payment becomes PAID only when the indexer sees `PaymentReceived` at the configured confirmation depth, never because `pay()` was sent.
  - Before settling or refunding, the worker reads `paymentOf(quoteId)`. If the chain already shows the result, it records it instead of sending again.
- **Every step can be repeated safely.**
  - **Database:** one payment per quote and one payout per payment, both enforced by unique keys. Status changes are conditional updates (`UPDATE … WHERE status = from`), so two workers can't both move a payment.
  - **Chain:** the indexer saves its block cursor after processing events, so a crash re-reads them, which is harmless.
  - **Partner:** payouts are created idempotently per payment ID.
- **Submission is asynchronous.** `POST /payments` checks everything it can off-chain (signature, expiry, limits), simulates `pay()`, sends it, and returns `202 SUBMITTED`. The app polls for the result.
- **A payment fails only when it provably can't succeed:**
  - the contract would revert (simulation), so nothing was sent;
  - `pay()` was mined and reverted;
  - or the quote expired more than a minute ago and the chain shows no payment. After expiry the contract rejects the quote, so it can never land.

  An unclear send error (a timeout after signing) keeps the payment SUBMITTED, with its hash, until one of those holds.
- **The relayer signs locally.** The transaction hash is known before sending, so resending the same bytes after a timeout is safe, and "already known" counts as sent. Sends are queued, with a tracked nonce that is re-read from the node when it's wrong.

## Consequences

- The backend can be stopped at any point and restarted. Workers pick up where the data says they are.
- Payments take a few seconds longer than a synchronous design: one confirmation wait plus polling.
- The app must poll until a final status (SETTLED, REFUNDED, FAILED).
- Run one instance of each worker. Two would be safe, because the conditional updates stop double transitions, but they'd race to send the same transactions.
- Not handled yet:
  - replacing a transaction stuck at too low a gas price;
  - a FAILED payment that later shows up as paid on-chain. This needs a person; it's logged as an error.
