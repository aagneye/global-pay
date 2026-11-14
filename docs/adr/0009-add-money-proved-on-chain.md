# ADR 0009: Add money is proved on-chain, not on the partner's word

- **Status:** Accepted
- **Date:** 2026-11-14

## Context

New wallets start empty, so users need a way to buy USDC with baht. The research ([production rails](../research/production-rails.md#2-add-money-onramp)) found that MoonPay is the only international onramp confirmed for Thailand with USDC on Base. MoonPay's interface has these properties:

- **The widget URL** carries the wallet address, so MoonPay requires it to be signed.
- **Webhooks** are signed (`Moonpay-Signature-V2`), but they arrive at least once and in no fixed order.
- **There's no "expired" status:** a purchase can wait for payment indefinitely.
- **The sandbox delivers on Ethereum Sepolia,** with a test token, not on Base.

Users also receive USDC from other wallets and exchanges, and that should show in their history too.

## Decision

**An order** (`src/domain/onramp.ts`) moves through these statuses:

- **CREATED**, waiting for payment;
- **PENDING**, paid, with the USDC on its way;
- **COMPLETED**;
- **FAILED**;
- **EXPIRED**, not paid within `ONRAMP_ORDER_TTL_MS` (one hour).

An expired order can still move to PENDING, COMPLETED or FAILED if the payment turns up later.

**COMPLETED needs proof on the chain** (`src/modules/onramp/onramp-tracker.ts`). MoonPay saying "completed" only moves the order to PENDING. It becomes COMPLETED once the delivery passes every check:

1. MoonPay's `cryptoTransactionId` is mined, didn't revert, and has `ONRAMP_CONFIRMATIONS` blocks on top.
2. It holds a `Transfer` of the configured token to the order's wallet.
3. The amount is the one MoonPay reported (`quoteCurrencyAmount`).
4. That transfer (transaction hash and log index) hasn't completed another order. A unique index enforces this.

**Other safeguards:**
- A purchase that MoonPay reports sending to a different wallet never completes.
- The wallet address in the widget URL comes from the user's record, never from the request.

**MoonPay is asked; webhooks only prompt** (`src/adapters/onramp/moonpay-provider.ts`). A webhook is accepted only if:
- its HMAC-SHA256 over `t.rawBody` matches, compared in constant time over the exact bytes received;
- its timestamp is within five minutes, so an old message can't be replayed.

The order is then fetched again with `GET /v1/transactions/ext/{orderId}`, so duplicates and out-of-order webhooks change nothing. The onramp worker also asks every `ONRAMP_RECHECK_MS`. An order expires only once MoonPay has confirmed that nothing was paid; an unreachable partner never expires an order.

**The delivery chain is configurable** (`ONRAMP_RPC_URL`, `ONRAMP_CHAIN_ID`, `ONRAMP_TOKEN_ADDRESS`), because the sandbox delivers on Ethereum Sepolia. It defaults to the payment chain and USDC. It's read through its own `TokenReader` port, separate from the settlement gateway.

**Deposits** (`src/workers/deposit-worker.ts`): a watcher reads USDC `Transfer` logs to users' wallets on the payment chain, through the same block cursor and range limits as the indexer. Each transfer is stored once. Refunds from the settlement contract are skipped, since they already show on their payment. `GET /me/deposits` lists deposits, and links each to the Add-money order it completed.

**Local development and tests** use `SimulatedOnrampProvider`:
- its checkout is a page on the API (`/onramp/simulator/:orderId`) with "pay" and "decline" buttons;
- paying mints mock USDC on anvil, so the order is proved on-chain like a real one;
- production refuses it.

**The app** opens the checkout in a Custom Tab, never a WebView, so it can't read card details. It re-checks the order when it comes back to the foreground.

## Consequences

- **"Added" lags MoonPay's own "completed"** by the confirmation wait. In return, the app never shows money the wallet doesn't have.
- **Splitting won't complete an order.** If MoonPay delivered the amount in two transfers, or a different amount, the order stays PENDING with a visible error until a person looks.
- **Old transfers aren't found as deposits.** The watcher starts at its cursor, so a user's transfers from before they signed up don't appear.
- **Simulator purchases live in memory.** A restart forgets them, and those orders expire.
- **Not done yet:**
  - **No operator view of stuck orders:** onramp orders don't appear on `/ops`.
  - **No sandbox run:** a real MoonPay sandbox purchase hasn't happened yet; it needs the owner's MoonPay keys.
  - **No legal review:** Thailand's Decree No. 2 on offshore digital-asset services needs counsel before launch.

## Update (iteration 10, 2026-11-14)

- **Expired orders are re-checked.** The onramp worker also asks about EXPIRED orders less than 24 hours old, so a purchase paid after its order expired still completes without a webhook or the user opening it.
- **Stuck orders don't block others.** The worker pages through open orders (round robin) instead of taking the oldest 50 every time.
- **Still not on `/ops`:** stuck onramp orders.
- **Production refuses sandbox settings:** MoonPay test keys, the sandbox widget URL, and a missing `MOONPAY_WEBHOOK_KEY`.
