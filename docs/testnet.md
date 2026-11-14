# Running GlobalPay on Base Sepolia

This is the runbook for iteration 7: deploy the settlement contract to Base Sepolia, point the backend and app at it, and pay with Circle's test USDC. **Testnet keys only.** Nothing here touches real money.

All commands run from `services/api` unless stated otherwise. They need Foundry ([setup](setup.md#4-contracts-contracts)).

## 0. Rehearse on a fork (optional, no funds needed)

```bash
BASE_SEPOLIA_FORK_URL=https://sepolia.base.org npx vitest run test/integration/base-sepolia-fork.test.ts
```

This runs a local copy of Base Sepolia. On it, the test:
- deploys with the real `Deploy.s.sol` and fresh keys;
- mints Circle test USDC to a payer by impersonating USDC's master minter;
- runs the backend through a settlement and a refund.

It's what step 3 does for real, so if this passes, the deploy script, the USDC signature and the settle and refund calls all work on Base Sepolia's actual USDC contract.

## 1. Make the keys

```bash
npm run testnet -- init
```

This creates two gitignored files:

| File | Holds |
|---|---|
| `contracts/.env` | deployer key (admin and pauser), role addresses, treasury key |
| `services/api/.env.base-sepolia` | quote signer and relayer keys, JWT secret, operator token, test payer key |

It prints the addresses, never the keys, and it refuses to overwrite either file. Delete them to start over, but only once you no longer need what's funded there.

## 2. Fund the addresses

| Address | Needs | Where |
|---|---|---|
| Deployer | ~0.01 Base Sepolia ETH | a Base Sepolia faucet, e.g. Coinbase Developer Platform or the Superchain faucet |
| Relayer | ~0.02 Base Sepolia ETH (it pays the gas for every payment) | same |
| Test payer | 10+ test USDC; **no ETH**: payments are gasless | [faucet.circle.com](https://faucet.circle.com), network "Base Sepolia" |

Check with:

```bash
npm run testnet -- status
```

It shows balances, the deployment and its roles, and what to do next.

## 3. Deploy

```bash
cd ../../contracts
forge script script/Deploy.s.sol --rpc-url base_sepolia --broadcast
cd ../services/api
npm run testnet -- record
```

**About the deploy:**
- `forge` reads `contracts/.env` itself.
- It deploys `GlobalPaySettlement`, grants the roles and allows USDC.
- Its broadcast record (`contracts/broadcast/Deploy.s.sol/84532/`) is committed as the deployment record.

**About `record`:** it copies the contract address and deployment block into `.env.base-sepolia` (`SETTLEMENT_ADDRESS`, `INDEXER_START_BLOCK`). Then `npm run testnet -- status` should show every check ticked.

**Verify on Basescan (optional):** set `ETHERSCAN_API_KEY` in `contracts/.env` (one Etherscan key works for Basescan), then either:
- add `--verify` to the deploy command; or
- verify afterwards: `forge verify-contract <address> GlobalPaySettlement --chain 84532 --watch`, with the constructor arguments from the broadcast record.

## 4. Run the backend

You need a Postgres for `DATABASE_URL` in `.env.base-sepolia`: the root `docker-compose.yml`, or `npx prisma dev` (see [setup](setup.md#2-database)). Then:

```bash
npx prisma migrate deploy   # with DATABASE_URL from .env.base-sepolia
npm run dev:testnet         # the API with .env.base-sepolia
```

Then pay as the test payer, through the running API:

```bash
npm run testnet -- pay 100
```

It follows the payment until it settles and prints the Basescan links.

**Exercise the other outcomes:**
- **A refund:** set `PAYOUT_FAILURE_RATE=1`, restart, pay again.
- **An unclear payout:** set `PAYOUT_UNKNOWN_RATE=1`. It shows on the operator page at `http://localhost:3000/ops` (token: `OPS_API_TOKEN` in `.env.base-sepolia`), where you can mark it paid.

## 5. The app

The app's defaults are already Base Sepolia (`CHAIN_ID=84532`). Run it against your backend without a dev key, so it makes its own wallet:

```bash
cd apps/mobile
flutter run --dart-define=API_BASE_URL=http://10.0.2.2:3000
```

Sign in, open **Receive** to see the wallet's address, and send it test USDC from the Circle faucet. Then scan a demo QR from `npm run qr:make`.

## 6. Real payouts: the Xendit sandbox (needs a Xendit test key)

1. In Xendit's dashboard (test mode), get the secret key. Then run `XENDIT_SECRET_KEY=xnd_development_… npm run xendit:sandbox` to see the THB balance and payout channels.
2. Put the Xendit settings in `.env.base-sepolia`:
   - `PAYOUT_PROVIDER=xendit`;
   - `XENDIT_SECRET_KEY`;
   - `XENDIT_PROMPTPAY_CHANNEL`, or `PAYOUT_TEST_DESTINATIONS` mapping the demo biller `099999999999901` to a test account.
3. Expose the API so Xendit can reach the webhook, e.g. with `cloudflared tunnel --url http://localhost:3000`. Then, in the dashboard:
   - set the payout webhook to `<tunnel URL>/webhooks/payouts/xendit`;
   - copy its verification token into `XENDIT_CALLBACK_TOKEN`.
4. Restart and `npm run testnet -- pay 100`. The payment should settle with a Xendit reference.

## 7. Add money: the MoonPay sandbox (needs MoonPay sandbox keys)

1. In MoonPay's dashboard (sandbox), copy the publishable key, the secret key and the webhook key.
2. In `.env.base-sepolia`, set:
   - `ONRAMP_PROVIDER=moonpay` and the three `MOONPAY_*` keys;
   - for the sandbox's delivery chain (Ethereum Sepolia), `ONRAMP_CHAIN_ID=11155111`, an `ONRAMP_RPC_URL` for Sepolia, `ONRAMP_EXPLORER_URL=https://sepolia.etherscan.io`, and `ONRAMP_TOKEN_ADDRESS` set to the token MoonPay's sandbox sends.
3. Register `<tunnel URL>/webhooks/onramp/moonpay` as the webhook.
4. In the app, choose **Add money**, pay with MoonPay's sandbox test card, and come back. The order should reach COMPLETED once the transfer is confirmed.

## Checklist (iteration 7 is done when)

- [ ] Contract deployed, roles checked by `npm run testnet -- status`, broadcast record committed
- [ ] A 100 THB payment settles: `pay` and `markSettled` on Basescan
- [ ] A forced payout failure refunds: `refund` on Basescan
- [ ] A forced UNKNOWN shows on `/ops` and settles after "Mark paid"
- [ ] With the Xendit sandbox: a payment settles with a Xendit reference
