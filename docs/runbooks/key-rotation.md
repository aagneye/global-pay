# Key rotation runbook

How to replace every secret GlobalPay uses, in a safe order, and what to do when one leaks. The commands are for the Base Sepolia setup in [testnet.md](../testnet.md); each section says what changes in production. Why each key matters is in the [threat model](../security.md).

Use this runbook:
- on a routine schedule (see the inventory);
- when someone with access leaves;
- at once, when a key may have leaked: start with [If a key leaks](#if-a-key-leaks).

## Rules

1. **Grant the new key before revoking the old one.** Never leave a role without a working holder. Losing the last `DEFAULT_ADMIN_ROLE` holder is permanent: the contract isn't upgradeable ([ADR 0006](../adr/0006-immutable-settlement-contract.md)), so nobody could grant roles, change the treasury or unpause again.
2. **Drain before you switch** anything that in-flight work depends on (the relayer's pending transactions, a partner account's open payouts).
3. **One key at a time.** Verify after each one before starting the next.
4. **Never type a private key on the command line** or paste it into chat, tickets or email. The commands below read keys from the gitignored env files. In production, keys never leave the KMS or the multisig.
5. **Write it down.** Keep a rotation log outside the repo: date, who, which key, old and new address, transaction hashes.

## Inventory

| Secret | Where it lives today (testnet) | Production home | If it leaks | Rotating it causes | Routine rotation |
|---|---|---|---|---|---|
| **Admin** (`DEFAULT_ADMIN_ROLE`) | `DEPLOYER_PRIVATE_KEY` in `contracts/.env` (the deploy script makes the deployer the admin) | A Safe multisig with hardware-wallet signers | Full control: roles, treasury (so every later `markSettled`), token allowlist, unpause | Nothing visible | Change Safe signers when people change |
| **Pauser** (`PAUSER_ROLE`) | Same deployer key (`PAUSER_ADDRESS` in `contracts/.env`) | A separate key held by whoever is on call | Pauses new payments (downtime only) | Nothing visible | Yearly, and when people change |
| **Quote signer** (`QUOTE_SIGNER_ROLE`) | `QUOTE_SIGNER_PRIVATE_KEY` in `services/api/.env.base-sepolia`; its address is `QUOTE_SIGNER_ADDRESS` in `contracts/.env` | KMS (non-exportable secp256k1 key) | Forged quotes. Until [WRK-1](../security.md#53-workers-and-relayer) is fixed, THB paid out of the float | Nothing visible (both keys overlap) | Quarterly |
| **Relayer / operator** (`OPERATOR_ROLE`) | `RELAYER_PRIVATE_KEY` in `.env.base-sepolia`; `OPERATOR_ADDRESS` in `contracts/.env` | KMS | `markSettled`/`refund` on any paid payment; its ETH | A few minutes without on-chain sends while it drains | Quarterly |
| **Treasury** | Contract setting; `TREASURY_ADDRESS` and the testnet `TREASURY_PRIVATE_KEY` in `contracts/.env` | A Safe multisig | Settled USDC | Nothing visible | When signers change |
| `JWT_SECRET` | `.env.base-sepolia` | Secret manager | Sessions for any user forged (data and actions, not funds) | Every user signs in again | Yearly |
| `OPS_API_TOKEN` | `.env.base-sepolia` | Replaced by per-person SSO ([OPS-1](../security.md#57-operator-console-ops)) | Operator actions on UNKNOWN payouts | Operators re-enter the token | When anyone who has it leaves; quarterly |
| `XENDIT_SECRET_KEY` | `.env.base-sepolia` | Secret manager | In production: payouts from our float to anyone | Nothing visible (same account) | Quarterly |
| `XENDIT_CALLBACK_TOKEN` | `.env.base-sepolia` | Secret manager | Forged webhooks, which only trigger lookups | Webhooks refused until restart; polling covers it | On leak |
| `MOONPAY_SECRET_KEY` (+ publishable key) | `.env.base-sepolia` | Secret manager | Widget URLs signed under our account | Checkout links already issued stop working | Yearly |
| `MOONPAY_WEBHOOK_KEY` | `.env.base-sepolia` | Secret manager | Forged webhooks, which only trigger lookups | Webhooks refused until restart; polling covers it | On leak |
| FCM service-account key | JSON file at `FCM_SERVICE_ACCOUNT_FILE` | No key file (workload identity), or a secret manager | Push messages to our users | Nothing visible | Every 90 days |
| App upload / signing key | Not set up: release builds use the debug key | Play App Signing (Google holds the signing key; we hold an upload key in a vault) | A malicious "update" of the app | Nothing visible | Only on leak |
| Dev wallet key | On the phone (`KeyVault`), or a `DEV_WALLET_PRIVATE_KEY` dart-define | None: replaced by the Privy wallet (iteration 11) | That wallet's test USDC | A new wallet is a new account | Never; replace it |
| Device key (tap to pay) | Phone's Android Keystore | Same | Tap identification as that phone | Re-register the phone | When a phone is lost |
| `DATABASE_URL` password | `.env.base-sepolia` | Secret manager | All data | A restart | Yearly |
| RPC provider key (inside `RPC_URL`) | `.env.base-sepolia` | Secret manager | Our RPC quota | A restart | On leak |
| `E2E_PAYER_PRIVATE_KEY`, `ETHERSCAN_API_KEY` | Env files | Not used in production | Test USDC; an Etherscan quota | Nothing | On leak |

## Before you start (testnet)

You need Foundry's `cast` ([setup](../setup.md#4-contracts-contracts)) and the two env files from `npm run testnet -- init`. Run everything in Git Bash, from `contracts/`:

```bash
cd contracts
set -a; source .env; set +a        # DEPLOYER_PRIVATE_KEY, BASE_SEPOLIA_RPC_URL, role addresses
export RPC="$BASE_SEPOLIA_RPC_URL"
api_env() { grep "^$1=" ../services/api/.env.base-sepolia | cut -d= -f2-; }
export SETTLEMENT=$(api_env SETTLEMENT_ADDRESS)

# Role IDs, read from the contract
role() { cast call "$SETTLEMENT" "$1()(bytes32)" --rpc-url "$RPC"; }
export DEFAULT_ADMIN_ROLE=$(role DEFAULT_ADMIN_ROLE)   # 0x00…00
export QUOTE_SIGNER_ROLE=$(role QUOTE_SIGNER_ROLE)
export OPERATOR_ROLE=$(role OPERATOR_ROLE)
export PAUSER_ROLE=$(role PAUSER_ROLE)

# Helpers
has_role() { cast call "$SETTLEMENT" "hasRole(bytes32,address)(bool)" "$1" "$2" --rpc-url "$RPC"; }
admin_send() { cast send "$SETTLEMENT" "$@" --private-key "$DEPLOYER_PRIVATE_KEY" --rpc-url "$RPC"; }
addr_of() { cast wallet address --private-key "$1"; }
```

The contract commands in this runbook were checked with Foundry 1.9 against a local anvil deployment of `GlobalPaySettlement`.

To make a new testnet key, run `cast wallet new`. It prints an address and a private key: paste the key straight into the env file, then clear the terminal.

**In production** the same calls apply, but:
- admin calls (`grantRole`, `revokeRole`, `setTreasury`, `setTokenAllowed`, `unpause`) are proposed and signed in the Safe (Transaction Builder, with the ABI from `contracts/out/GlobalPaySettlement.sol/GlobalPaySettlement.json` after `forge build`);
- backend keys are new KMS keys, not files. The backend can't use a KMS signer yet (`ViemQuoteSigner` and the relayer take raw keys; [ADR 0005](../adr/0005-partner-ports-and-simulated-adapters.md) lists a KMS signer for production), so that support is a launch item;
- `npm run testnet -- status` only knows Base Sepolia, so use the `cast` checks in [Verify](#verify-after-every-rotation).

## Contract keys

### Quote signer

The contract accepts quotes from any `QUOTE_SIGNER_ROLE` holder, so both keys can be valid for a short overlap and no payment fails.

1. Make a key (`cast wallet new`) and note its address as `NEW_SIGNER`. Note the current one: `OLD_SIGNER=$(addr_of "$(api_env QUOTE_SIGNER_PRIVATE_KEY)")`.
2. Grant the role (admin):
   ```bash
   admin_send "grantRole(bytes32,address)" "$QUOTE_SIGNER_ROLE" "$NEW_SIGNER"
   has_role "$QUOTE_SIGNER_ROLE" "$NEW_SIGNER"   # true
   ```
3. Put the new key in `QUOTE_SIGNER_PRIVATE_KEY` in `services/api/.env.base-sepolia`, and its address in `QUOTE_SIGNER_ADDRESS` in `contracts/.env` (used by future deploys). Restart the API.
4. Wait at least `QUOTE_TTL_SECONDS` (60 s) plus a minute, so every quote the old key signed has expired.
5. Revoke the old key:
   ```bash
   admin_send "revokeRole(bytes32,address)" "$QUOTE_SIGNER_ROLE" "$OLD_SIGNER"
   has_role "$QUOTE_SIGNER_ROLE" "$OLD_SIGNER"   # false
   ```
6. [Verify](#verify-after-every-rotation).

**Order matters.** If the API switches before step 2, every payment is refused when it's simulated (`payment_rejected`, `InvalidQuoteSigner`). No money moves, but nobody can pay until the grant lands.

### Relayer (operator)

The relayer sends `pay`, `markSettled`, `refund` and tap-to-pay `transferWithAuthorization` calls. Only `markSettled` and `refund` need `OPERATOR_ROLE`; the other two are permissionless. Payments keep their transaction hashes, so the indexer reconciles them whichever key is configured. What needs draining is the old key's own pending transactions: otherwise the new key may send a second `markSettled` for the same payment, which reverts (safe, but it wastes gas and shows up on `/ops`).

1. Make a key (`NEW_RELAYER`) and send it Base Sepolia ETH (at least `OPS_MIN_RELAYER_ETH`; 0.02 is plenty). Note the current one: `OLD_RELAYER=$(addr_of "$(api_env RELAYER_PRIVATE_KEY)")`.
2. Grant the role:
   ```bash
   admin_send "grantRole(bytes32,address)" "$OPERATOR_ROLE" "$NEW_RELAYER"
   ```
3. **Drain:** stop the API, then wait until the old key has nothing pending (both numbers equal):
   ```bash
   cast nonce "$OLD_RELAYER" --block pending --rpc-url "$RPC"
   cast nonce "$OLD_RELAYER" --block latest --rpc-url "$RPC"
   ```
4. Move the old key's ETH to the new one, leaving about 0.0001 ETH for the fee:
   ```bash
   cast balance "$OLD_RELAYER" --ether --rpc-url "$RPC"
   cast send "$NEW_RELAYER" --value <amount>ether --private-key "$(api_env RELAYER_PRIVATE_KEY)" --rpc-url "$RPC"
   ```
5. Put the new key in `RELAYER_PRIVATE_KEY` (`.env.base-sepolia`) and its address in `OPERATOR_ADDRESS` (`contracts/.env`). Start the API.
6. Check `/ops/api/health` shows the new relayer address with no gas alert, and that a test payment settles (`npm run testnet -- pay 100`) with the new address as the `from` of `markSettled` on Basescan.
7. Revoke the old key:
   ```bash
   admin_send "revokeRole(bytes32,address)" "$OPERATOR_ROLE" "$OLD_RELAYER"
   ```

### Pauser

1. Make or choose the new pauser (`NEW_PAUSER`). On the testnet the pauser is the deployer, so note `OLD_PAUSER=$(addr_of "$DEPLOYER_PRIVATE_KEY")`.
2. Grant, check, revoke:
   ```bash
   admin_send "grantRole(bytes32,address)" "$PAUSER_ROLE" "$NEW_PAUSER"
   has_role "$PAUSER_ROLE" "$NEW_PAUSER"           # true
   admin_send "revokeRole(bytes32,address)" "$PAUSER_ROLE" "$OLD_PAUSER"
   has_role "$PAUSER_ROLE" "$OLD_PAUSER"           # false
   ```
3. Update `PAUSER_ADDRESS` in `contracts/.env`.
4. On the testnet only, prove it works: with the new pauser's key in `NEW_PAUSER_KEY`, pause, check, and unpause as admin:
   ```bash
   cast send "$SETTLEMENT" "pause()" --private-key "$NEW_PAUSER_KEY" --rpc-url "$RPC"
   cast call "$SETTLEMENT" "paused()(bool)" --rpc-url "$RPC"   # true
   admin_send "unpause()"
   ```

**What pausing does:** `pause()` stops new `pay()` calls, so `POST /payments` answers `payment_rejected`. `markSettled` and `refund` keep working, so in-flight payments still resolve. Tap-to-pay transfers don't go through the contract and **aren't stopped by a pause**: to stop them, stop the API or unset `RELAYER_PRIVATE_KEY` and restart. Only the admin can `unpause()`.

### Admin: move it to a multisig

Do this before mainnet, and rehearse it on Base Sepolia first. After it, the deployer key has no power.

1. Create a Safe on the **same chain** as the contract, with hardware-wallet signers and a threshold such as 2 of 3. Note its address as `SAFE`, and check it exists there: `cast code "$SAFE" --rpc-url "$RPC"` must not print `0x`.
2. Grant it the admin role:
   ```bash
   admin_send "grantRole(bytes32,address)" "$DEFAULT_ADMIN_ROLE" "$SAFE"
   has_role "$DEFAULT_ADMIN_ROLE" "$SAFE"    # true
   ```
3. **Prove the Safe can act** before removing the deployer. From the Safe's Transaction Builder, call `setTokenAllowed(<USDC address>, true)`. USDC is already allowed, so nothing changes, but it needs the admin role, and the `TokenAllowed` event shows the Safe could execute it.
4. Remove the deployer. OpenZeppelin 5 asks the caller to confirm its own address:
   ```bash
   DEPLOYER=$(addr_of "$DEPLOYER_PRIVATE_KEY")
   admin_send "renounceRole(bytes32,address)" "$DEFAULT_ADMIN_ROLE" "$DEPLOYER"
   has_role "$DEFAULT_ADMIN_ROLE" "$DEPLOYER"   # false
   has_role "$DEFAULT_ADMIN_ROLE" "$SAFE"       # true
   ```
5. Move the pauser off the deployer too ([Pauser](#pauser)), so one key can't be both.
6. From now on, every admin call is a Safe transaction. Changing who signs is done inside the Safe (add or remove an owner, change the threshold); the contract doesn't change.

`AccessControl` doesn't list role holders. To see every holder, read the `RoleGranted` events since the deployment block, then the same with `RoleRevoked`:

```bash
cast logs --from-block "$(api_env INDEXER_START_BLOCK)" --address "$SETTLEMENT" \
  "RoleGranted(bytes32 indexed role, address indexed account, address indexed sender)" --rpc-url "$RPC"
```

The public Base Sepolia RPC answers at most 200 blocks per query; use a provider URL, or add `--to-block` and step through the range.

### Treasury

`setTreasury` takes effect for every later `markSettled`, including payments already in the contract (the treasury is read at settle time). Nothing needs draining.

1. Choose the new treasury (`NEW_TREASURY`): a Safe in production, checked with `cast code` as above, on the right chain.
2. Keep the old values in your shell for step 5: `OLD_TREASURY=$TREASURY_ADDRESS OLD_TREASURY_KEY=$TREASURY_PRIVATE_KEY`. Then update `TREASURY_ADDRESS` in `contracts/.env` first (`npm run testnet -- status` compares the contract with it), and `TREASURY_PRIVATE_KEY` if the new one is a testnet key.
3. Set it (admin) and check:
   ```bash
   admin_send "setTreasury(address)" "$NEW_TREASURY"
   cast call "$SETTLEMENT" "treasury()(address)" --rpc-url "$RPC"
   ```
4. After the next payment settles, check its `PaymentSettled` event names the new treasury.
5. Move the old treasury's USDC (from the old treasury key or Safe):
   ```bash
   USDC=$(api_env USDC_ADDRESS)
   cast call "$USDC" "balanceOf(address)(uint256)" "$OLD_TREASURY" --rpc-url "$RPC"
   cast send "$USDC" "transfer(address,uint256)" "$NEW_TREASURY" <amount> --private-key "$OLD_TREASURY_KEY" --rpc-url "$RPC"
   ```

## Backend secrets

All of these live in `services/api/.env.base-sepolia` on the testnet (a secret manager in production). After changing one, restart the API.

### JWT_SECRET

There's one secret and no key ID, so changing it invalidates every session at once ([API-1](../security.md#52-backend-api-servicesapi)). The app sends users back to sign-in on a 401 (`api_client.dart`). Pick a quiet time.

1. Generate: `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`.
2. Set `JWT_SECRET` and restart.
3. Verify: a request with an old token gets `401 invalid_token`; a fresh sign-in works (`npm run testnet -- pay 1` signs in as the test payer).

A stolen *token* (not the secret) stays valid until it expires (`JWT_TTL_SECONDS`, 24 hours). There's no per-token revocation, so to cut one off early you rotate the secret.

### OPS_API_TOKEN

1. Generate 32+ characters the same way, set `OPS_API_TOKEN`, restart.
2. Give the new token to operators through the team's password manager, never chat or email. They re-enter it on `/ops` (the page keeps it in the browser tab's session storage only).
3. Verify, with the old token in `OLD_TOKEN`: it gets 401, and the new one gets 200:
   ```bash
   curl -s -o /dev/null -w "%{http_code}\n" -H "X-Ops-Token: $OLD_TOKEN" http://localhost:3000/ops/api/health
   ```

### Xendit secret key and callback token

**Secret key** (`XENDIT_SECRET_KEY`):
1. In Xendit's dashboard (test mode for the sandbox), go to the API keys settings and create a key with only what the adapter uses: payouts (write) and balance (read).
2. Set it and restart.
3. Verify: `/ops/api/health` shows the partner float; with a test key, `npm run xendit:sandbox` lists the THB channels; a test payment settles with a Xendit reference.
4. Delete the old key in the dashboard.

Payouts are looked up by `reference_id` within the account, so open PENDING and UNKNOWN payouts carry on with the new key. **Moving to a different Xendit account is not a key rotation:** the new account can't see the old account's payouts, so the tracker would find nothing and create them again, paying merchants twice. Drain first: no payouts PENDING or UNKNOWN (check `/ops/api/health`), then switch.

**Callback token** (`XENDIT_CALLBACK_TOKEN`):
1. Generate a new verification token in the dashboard's webhook settings (if it doesn't offer that, ask Xendit support).
2. Set it and restart.
3. Verify: the next payout webhook is logged as `payout webhook`, not answered 401.

Between the dashboard change and the restart, webhooks get 401. Xendit retries, and the payout worker asks Xendit itself every `PAYOUT_RECHECK_MS`, so nothing is lost.

### MoonPay keys

**Secret and publishable keys:**
1. In MoonPay's dashboard (Developers page), regenerate the keys.
2. Set `MOONPAY_SECRET_KEY` and `MOONPAY_PUBLISHABLE_KEY`, and restart.
3. Verify: start Add money in the app; the checkout opens with no signature error.

Checkout links issued before the switch were signed with the old key and stop working; those users start Add money again. Open orders are looked up by our order ID on the same account, so they carry on. As with Xendit, moving to a **different MoonPay account** needs open orders (CREATED, PENDING) drained first.

**Webhook key** (`MOONPAY_WEBHOOK_KEY`): regenerate it in the dashboard, set it, restart. Webhooks are refused (401) until the restart; the onramp worker asks MoonPay every `ONRAMP_RECHECK_MS`, so nothing is lost. Verify: the next webhook is logged as `onramp webhook`.

### FCM service-account key

1. In Google Cloud (IAM → Service accounts → the FCM account → Keys), add a JSON key. While there, check the account has only the Firebase Cloud Messaging role.
2. Save the file **outside the repo** (`chmod 600`), point `FCM_SERVICE_ACCOUNT_FILE` at it, restart.
3. Verify: a tap-to-pay request sends a push, and the logs show no FCM auth errors.
4. Delete the old key in the console. Access tokens already made with it stay valid until they expire (up to an hour).

If push breaks, tap to pay still works: the payer's screen polls.

### Database password and RPC key

- **Database:** create a new Postgres password (or role), update `DATABASE_URL`, restart, then remove the old one.
- **RPC provider key:** regenerate it at the provider, update `RPC_URL` (and `ONRAMP_RPC_URL` if set), restart.

## App and phone keys

### App release signing key

Today there isn't one: release builds are signed with the debug key ([`build.gradle.kts`](../../apps/mobile/android/app/build.gradle.kts)). Setting it up is part of iteration 10.

**Set up once:**
1. Enrol in **Play App Signing**: Google keeps the app signing key, and we keep only an upload key.
2. Make the upload key: `keytool -genkeypair -v -keystore upload-keystore.jks -keyalg RSA -keysize 2048 -validity 10000 -alias upload`.
3. Keep the keystore and its passwords in the team vault. Never commit them: add `*.jks` and `key.properties` to `.gitignore` when release signing is wired up.
4. Protect the Play Console account with MFA. Uploading needs both the upload key and the account.

**If the upload key is lost or leaked:**
1. Make a new upload key and export its certificate: `keytool -export -rfc -keystore upload-keystore.jks -alias upload -file upload_certificate.pem`.
2. In Play Console, under App signing, request an upload key reset and upload the certificate. Don't publish until Google confirms.

The app signing key itself rarely changes. Play Console offers a one-time signing key upgrade (Android 9+ verifies the rotation), needed only if that key is compromised.

**Verify a build:** `keytool -printcert -jarfile app-release.aab` (or `apksigner verify --print-certs app-release.apk`) must not show `CN=Android Debug`.

### Dev wallet

The dev wallet is for the testnet only ([`dev_wallet_service.dart`](../../apps/mobile/lib/services/wallet/dev_wallet_service.dart)). There's no "rotate" in the app: replacing the key means a new wallet, and since users are keyed by wallet address, a new account that must pass KYC again.

1. If you want to keep its test USDC, send it to the new wallet first (tap to pay, or `cast` if you hold the key because it came from `DEV_WALLET_PRIVATE_KEY`).
2. Uninstall and reinstall the app. This also deletes its Keystore keys. The next start makes a new key and seals it with the fingerprint.

Changing the phone's fingerprints has the same effect: the sealed key can't be opened any more ([ADR 0010](../adr/0010-tap-to-pay.md)).

A `DEV_WALLET_PRIVATE_KEY` dart-define is compiled into the app, so only ever use public test keys there (such as anvil's account #4). If a funded key ended up in a build, treat its funds as gone: move what's left with `cast` and never use that key again.

### Device keys (tap to pay)

Each phone's P-256 key stays in its Keystore. If a phone is lost, revoke it with `DELETE /devices/:id` from the same account; the backend then refuses taps from it. A thief can't use the key without unlocking the phone (`requireDeviceUnlock`), and can't approve a payment without the fingerprint. With the dev wallet the account lives on the phone, so revoking from another phone needs the Privy wallet (iteration 11).

## Verify after every rotation

1. `npm run testnet -- status` (from `services/api`) shows every check ticked:
   - the quote signer and relayer from `.env.base-sepolia` hold their roles;
   - USDC is allowed;
   - the treasury matches `contracts/.env`.
2. It doesn't check old keys, the admin or the pauser, so check those with `cast`:
   ```bash
   has_role "$QUOTE_SIGNER_ROLE" "$OLD_SIGNER"     # false
   has_role "$OPERATOR_ROLE" "$OLD_RELAYER"        # false
   has_role "$DEFAULT_ADMIN_ROLE" "$SAFE"          # true (or the deployer, before the multisig)
   has_role "$PAUSER_ROLE" "$NEW_PAUSER"           # true
   cast call "$SETTLEMENT" "paused()(bool)" --rpc-url "$RPC"   # false
   ```
3. `/ops/api/health` (with `X-Ops-Token`) has no alerts.
4. `npm run testnet -- pay 100` settles.
5. The rotation log has the date, the key, both addresses and the transaction hashes.

## If a key leaks

1. **Declare an incident.** One person leads. Keep a timeline (UTC times, actions, transaction hashes).
2. **Contain it** with the first action in the table below, within minutes. Containment comes before rotation and before investigation.
3. **Rotate** with the section above.
4. **Assess the damage** (below).
5. **Recover and tell people:** refund or recover funds, tell the partner, and if personal data may have been exposed, follow the PDPA steps in the [launch checklist](../launch-checklist.md#8-incident-response) (the regulator within 72 hours unless the risk is low).
6. **Review:** how it leaked, the fix, and updates to this runbook and the [threat model](../security.md).

| Leaked | First action | Then |
|---|---|---|
| **Admin, single key** (testnet setup) | Pause with the pauser, if it's a different key. Stop the API. Before any `markSettled`, check `treasury()` hasn't changed; if it has, don't settle | You can't win a race against someone holding the same key. Deploy a new contract with admin on a Safe and point the backend at it. The backend follows one `SETTLEMENT_ADDRESS`, so resolve the old contract's paid payments by hand (`markSettled`/`refund` with the operator key, per the database) while the operator role still works. In-flight funds are the exposure |
| **Admin, one Safe signer** | Remove that owner with the other signers | Add a replacement signer |
| **Pauser** | Revoke `PAUSER_ROLE` (admin), then unpause if they paused | Grant a new pauser |
| **Quote signer** | Stop the API (holds payouts). Pause. Revoke `QUOTE_SIGNER_ROLE` at once, without waiting for quotes to expire | Grant a new key and switch. Before restarting, compare every `PaymentReceived` since the leak with its stored quote (below), because the indexer doesn't ([WRK-1](../security.md#53-workers-and-relayer)). Mark any mismatch for an operator. Then start the API and unpause |
| **Relayer** | Revoke `OPERATOR_ROLE` (admin). Stop the API, or unset `RELAYER_PRIVATE_KEY` and restart | Look for `PaymentSettled`/`PaymentRefunded` the worker didn't send (below). New key, funded, granted |
| **Treasury key** | `setTreasury` to a safe address (admin), then move the funds | — |
| `JWT_SECRET` | Rotate (signs everyone out) | Review what was read during the exposure; decide whether it's a PDPA breach |
| `OPS_API_TOKEN` | Rotate | Review `OpsAction` since the exposure. For any action your team didn't take, ask the partner whether the merchant was paid, and refund or pay by hand |
| `XENDIT_SECRET_KEY` | Delete the key in the dashboard, even before the new one is deployed. Meanwhile Xendit answers 401: payouts wait and are retried, and quotes are refused with `payouts_unavailable` because the float can't be read | Compare the dashboard's payouts with ours (`reference_id` is our payment ID); report others to Xendit |
| `XENDIT_CALLBACK_TOKEN`, `MOONPAY_WEBHOOK_KEY` | Rotate at normal pace (forged webhooks only cause lookups) | — |
| `MOONPAY_SECRET_KEY` | Regenerate in the dashboard | Review purchases on our MoonPay account |
| FCM key | Delete it in Google Cloud | If users received phishing pushes, warn them in the app |
| Upload key | Request an upload key reset; check the Play Console account and its MFA | — |
| `DATABASE_URL` | Rotate the password; restrict network access to the database | Treat as a personal-data breach until shown otherwise |
| Dev wallet key | Move what's left | New wallet |

### Assessing on-chain damage

Find the block for the time of the leak, then read what the contract did since:

```bash
FROM=$(cast find-block <unix-time-of-leak> --rpc-url "$RPC")
logs() { cast logs --from-block "$FROM" --address "$SETTLEMENT" "$1" --rpc-url "$RPC"; }
logs "PaymentRefunded(bytes32 indexed quoteId, address indexed payer, uint256 tokenAmount)"
logs "PaymentSettled(bytes32 indexed quoteId, address indexed treasury, uint256 tokenAmount)"
logs "TreasuryUpdated(address indexed treasury)"
logs "RoleGranted(bytes32 indexed role, address indexed account, address indexed sender)"
logs "PaymentReceived(bytes32 indexed quoteId, address indexed payer, address indexed token, uint256 tokenAmount, bytes3 fiatCurrency, uint256 fiatAmount, bytes32 merchantRefHash)"
```

With the `indexed` markers, `cast` prints each event decoded.

- **Settles and refunds:** compare each transaction hash with `settleTxHash` / `refundTxHash` on the `Payment` row. One we didn't send is the attacker's. A refund whose payout SUCCEEDED is money to recover from the payer; a settle whose payout failed is a refund we owe the user from the treasury.
- **Payments received:** compare each event's `payer`, `tokenAmount`, `fiatAmount` and `merchantRefHash` with the stored quote:
  ```sql
  SELECT id, payer, "tokenAmount", "fiatAmount", "merchantRefHash" FROM "Quote" WHERE id = '<quoteId>';
  ```
- **Roles and treasury:** any `RoleGranted` or `TreasuryUpdated` you didn't make means the admin key is in someone else's hands.

The public RPC answers at most 200 blocks per `eth_getLogs`; use a provider URL or step through with `--to-block`.
