# ADR 0008: Payout outcomes: UNKNOWN, idempotent retries and operator reconciliation

- **Status:** Accepted
- **Date:** 2026-11-13

## Context

Until iteration 5 the payout partner was simulated. It answered only "pending", "succeeded" or "failed", and the worker settled or refunded on that answer. A real partner (Xendit in the sandbox, a licensed Thai partner in production) is not so tidy:

- **Unclear creates.** A create request can time out or return a server error after the partner has accepted it. Re-sending without care pays the merchant twice. Refunding on a timeout loses the merchant's money.
- **Success without proof.** A success might come without a bank reference.
- **Late reversals.** Xendit can move a SUCCEEDED payout to REVERSED later.
- **Unauthenticated webhooks.** Webhooks carry only a static token, so a leaked token could forge a "succeeded".
- **Limited rails and float.** The rail may not pay every QR type: Xendit's PromptPay rail doesn't pay tag 30 biller QRs. And the partner's float can run out.

[The research](../research/production-rails.md) has the endpoints and statuses.

## Decision

**Payout statuses** (`src/domain/payment.ts`):

| From | To |
|---|---|
| PENDING | SUCCEEDED, FAILED, UNKNOWN |
| UNKNOWN | PENDING (the partner answers "pending" again), SUCCEEDED, FAILED |
| SUCCEEDED | REVERSED |
| FAILED, REVERSED | (final) |

- **SUCCEEDED** needs a reference: the bank or rail reference, else the partner's own payout ID. A success without one becomes UNKNOWN.
- **FAILED** only on a definite failure: FAILED or CANCELLED from the partner, a 4xx validation error on create, or an operator's approved refund.
- **UNKNOWN** for everything unclear:
  - timeouts, 5xx errors, 409 duplicates and unmapped statuses;
  - an unexpected "reversed" before success;
  - a payout still pending after `PAYOUT_PENDING_DEADLINE_MS` (30 minutes).

  It is re-checked with backoff: half its age, between 30 seconds and an hour. **It is never settled or refunded automatically.** The payment stays PAYOUT_PENDING with its USDC in the contract.
- **REVERSED** only after SUCCEEDED. It's shown to operators. The USDC is already in the treasury, so a person contacts the merchant or partner.

These are payout statuses only. The payment's status machine ([ADR 0007](0007-chain-is-the-source-of-truth.md)) is unchanged. The API adds `payout {status, provider, reference}`. The app shows "Merchant paid" only for SUCCEEDED with a reference, and "Needs review" for UNKNOWN or REVERSED.

**No double payout** (`src/modules/payouts/payout-tracker.ts`):

1. The payout row and its idempotency key (the payment ID) are stored before the partner is called. The key is sent as Xendit's `Idempotency-key` header and as `reference_id`.
2. A check with no partner ID first looks the payout up by `reference_id`.
3. Only if the partner has none is it created again, with the same key and body.
4. Every partner answer is stored as a `PayoutEvent` for audit.

**Webhooks are hints** (`POST /webhooks/payouts/:partner`):

1. The token is compared in constant time.
2. The body is stored as an event.
3. The payout is fetched from the partner.
4. The same rules as the worker are applied.

So a forged webhook can't settle anything. The route answers 200 for anything authentic, even a payout we don't know, so the partner stops retrying.

**Refuse up front.** Quotes return:
- 422 `merchant_not_supported` when the active rail can't pay the QR;
- 503 `payouts_unavailable` when the float minus the amount would drop below `PAYOUT_FLOAT_BUFFER_THB`, or the float can't be read.

**Operators** (`/ops`, `src/modules/ops/`):

- **Access.** `OPS_API_TOKEN` in the `X-Ops-Token` header, separate from user sign-in. The console is off when the token isn't set.
- **Exceptions list:**
  - PAID with no payout;
  - UNKNOWN, escalated after `OPS_ESCALATE_AFTER_MS`;
  - REVERSED;
  - partner errors;
  - settle or refund transactions that keep failing;
  - conflicts: the partner reports paid after we refunded.
- **Health:** the payout float and the relayer's gas against thresholds.
- **Actions.** Each is allowed only from UNKNOWN. Each first re-checks the partner without creating anything, and gives up if the partner now has an answer. Each is written to the `OpsAction` audit log, with the operator's name and a note.
  - **Re-check:** ask now, ignoring the backoff.
  - **Mark paid:** needs a bank or partner reference. The worker then settles.
  - **Approve refund:** only after `OPS_REFUND_COOLOFF_MS` (1 hour), and only when the partner has no record of the payout. If the partner has it, the refund waits for the partner to say FAILED.

## Consequences

- **A partner outage holds payments.** They stay PAYOUT_PENDING and nobody loses money. Users see "Needs review" and wait longer, up to the operator's response time.
- **Operators are part of the system.** Someone must watch `/ops` (or alerts built on `/ops/api/health`).
- **A narrow race remains.** If a re-check creates the payout at the moment an operator approves a refund, the merchant can be paid and the user refunded. The cooling-off period and the "no record at the partner" rule make this unlikely. If the partner later reports the payout as paid, it is flagged as a `payout_conflict`.
- **Reversals are caught by webhooks only.** A REVERSED after settlement is seen only through the webhook: polling stops once the payment is final.
- **The float check is a guard, not a reservation.** Payouts already in flight aren't subtracted.
- **One shared operator token.** The operator name is self-declared. Per-person operator accounts come with production hardening (iteration 10).
