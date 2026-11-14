# Launch checklist

What must be true before GlobalPay moves real money. It expands the roadmap's "Before real money" list into items someone can check, and it closes the gaps in the [threat model](security.md) that matter for launch.

Every item is one of two kinds:
- **[auto]**: an automated check, a command or test that passes or fails. The evidence is its output.
- **[sign-off]**: a manual sign-off. A named person checks it, signs and dates it, and links the evidence (a document, a contract, a screenshot, a transaction).

**How to use it.** Copy it into a launch ticket. Give each item an owner and a date. An item can be waived only in writing, by the project owner and the compliance lead, with the risk named and a date to close it. Nothing goes live until every item is done or waived, and the [1-baht payment](#10-go-live-the-controlled-1-baht-payment) is the last step.

Roadmap iteration 10 is done when **A1–A11 pass on a signed release build**. A12–A16 need production infrastructure and are part of launch.

## Automated checks

| ID | Check | How | State today |
|---|---|---|---|
| A1 | Contract tests pass | `forge test` (in `contracts/`) | Exists |
| A2 | Contract coverage stays at 100% of lines and branches | `forge coverage --report summary --no-match-coverage "(test\|script)/"` | Exists, but someone reads the numbers; make it fail below 100% in CI |
| A3 | Contract formatting and lint are clean | `forge fmt --check && forge lint` | Exists |
| A4 | Backend type-checks and its tests pass, including Postgres, anvil and the Base Sepolia fork | `npm run typecheck && npm test` (in `services/api`, with `TEST_DATABASE_URL` and Foundry) | Exists |
| A5 | The committed OpenAPI spec matches the routes | `test/openapi.test.ts` (part of A4) | Exists |
| A6 | App analysis and tests pass | `flutter analyze && flutter test` (in `apps/mobile`); includes `test/release/` (no logging, manifest settings) | Exists |
| A7 | Production refuses unsafe settings | `test/env.test.ts` (part of A4): with `NODE_ENV=production` the server refuses the anvil chain and keys, guessable secrets, `RATE_SOURCE=fixed`, rate limits off, simulated partners, `PAYOUT_TEST_DESTINATIONS`, Xendit and MoonPay test keys, MoonPay's sandbox widget, a real partner without its webhook secret, `MERCHANT_QR_ONLY=false` and a `.local` `SIWE_DOMAIN` ([`env.ts`](../services/api/src/config/env.ts)) | Exists (It. 10). The mock KYC provider can't be refused until a real KYC adapter exists (section 3) |
| A8 | The release build is signed with the release key, not the debug key | `bash tool/check_release.sh` (in `apps/mobile`, after `flutter build apk --release`): `apksigner` must verify a certificate other than `CN=Android Debug` | Exists (It. 10). Fails until the owner adds the upload key (`android/key.properties`); with a key it passes |
| A9 | The release build allows no plain HTTP, isn't debuggable and stays out of backups | `bash tool/check_release.sh`: the merged manifest has neither `debuggable` nor `usesCleartextTraffic`, `allowBackup` is off, and the network security config refuses cleartext | Exists (It. 10). Passes |
| A10 | The release build has no dev wallet and no test keys | `bash tool/check_release.sh`: none of anvil's public keys is in `libapp.so`. The dev wallet is offered only when `kDebugMode` ([`providers.dart`](../apps/mobile/lib/core/providers.dart)), and release builds drop `DEV_WALLET_PRIVATE_KEY` at compile time | Exists (It. 10). Passes |
| A11 | The release build talks only to the production API over HTTPS | Release builds stop at startup on a non-`https` `API_BASE_URL` ([`app_config.dart`](../apps/mobile/lib/core/config/app_config.dart)), tested by `test/core/app_config_test.dart` (part of A6); Android refuses cleartext too (A9) | Exists (It. 10) |
| A12 | The mainnet deployment is wired as intended | A script that reads the chain: admin is the Safe only (the deployer has no admin role), the pauser isn't an admin key, quote signer and operator are the KMS addresses, USDC is allowed, the treasury is the treasury Safe, not paused, source verified | To build. `npm run testnet -- status` does part of this for Base Sepolia only (not admin or pauser) |
| A13 | No known high or critical vulnerabilities in production dependencies | `npm audit --omit=dev --audit-level=high` | To add to CI |
| A14 | No secrets in the repository or its history | A secret scanner (e.g. gitleaks) over the repo | To add to CI |
| A15 | Monitoring answers | The external monitor reaches `/health` and `/ops/api/health`, and a test alert pages whoever is on call | To build ([9. Monitoring](#9-monitoring-and-alerting)) |
| A16 | Every change runs A1–A6, A13 and A14 | CI on every push and pull request | To build: there's no CI today |

## 1. Legal and regulatory

These are questions for Thai counsel to answer in writing. This list isn't legal advice. The research behind it is in [production rails](research/production-rails.md#regulation).

- [ ] **LEG-1 [sign-off]** A written Thai legal opinion that covers:
  - **The SEC's crypto-payment ban** (since 1 April 2022): licensed digital-asset businesses may not support crypto as a means of payment. Does our structure (the user pays USDC into our contract; a licensed partner pays the merchant baht) fall under it, for foreign residents and for Thai residents? ([Scope](scope.md) keeps Thai residents out for now.)
  - **The Payment Systems Act B.E. 2560 (2017):** does GlobalPay need a Bank of Thailand licence or registration (e-money, payment facilitation), or can it act only as a technology provider to a licensed partner? Who holds the merchant relationship?
  - **Decree No. 2 (2025)** amending the digital-asset decree, which extends licensing to offshore digital-asset services for people in Thailand. Does it catch our wallet app, our contract, or MoonPay's onramp as we embed it ([ADR 0009](adr/0009-add-money-proved-on-chain.md))?
  - **TouristDigiPay:** can our users (foreign residents on DTV visas, not only tourists) use it, and within what monthly limits?
  - **Exchange control:** converting a US-dollar stablecoin into baht.
  - **AML:** are we a reporting entity under the Anti-Money Laundering Act, or is the partner? What must we screen and report?
  - **Tax** on the spread.
- [ ] **LEG-2 [sign-off]** The company structure counsel recommends exists (a Thai company if needed), with a written note of who holds which licence.
- [ ] **LEG-3 [sign-off]** Terms of service and the privacy notice, in Thai and English, reviewed by counsel. They state that GlobalPay never holds funds before payment, the spread, and how long an unclear payout can take before a refund ([ADR 0008](adr/0008-payout-outcomes-and-reconciliation.md)).
- [ ] **LEG-4 [sign-off]** A sanctions policy: which lists we screen against and which countries we refuse.

## 2. Partners

- [ ] **PTR-1 [sign-off]** A signed contract with a **licensed payout partner**: Krungsri's corporate API (pays PromptPay IDs and tag 30 bill-payment QRs) or a TouristDigiPay exchange and e-money operator. It covers:
  - idempotent creates and lookup by our reference;
  - final statuses and late reversals;
  - webhook authentication (ask for signed webhooks, not a static token);
  - a name inquiry before payout, so the app can show the real payee ([APP-4](security.md#51-mobile-app-appsmobile));
  - daily statements for reconciliation;
  - how our float is held, and what happens to it if the partner fails;
  - a support contact and response time for unclear payouts.
- [ ] **PTR-2 [auto]** The partner's `PayoutProvider` adapter passes the same tests as Xendit's: every status, timeouts, 5xx errors, duplicates, and lookup before re-create ([`xendit-provider.test.ts`](../services/api/test/xendit-provider.test.ts) is the model).
- [ ] **PTR-3 [sign-off]** The partner's API key allows payouts only, is restricted to our servers' IPs if the partner offers it, and lives in the secret manager ([PAY-1](security.md#55-payout-partner-xendit-sandbox-krungsri-or-a-licensed-partner-in-production)).
- [ ] **PTR-4 [sign-off]** A float policy: the most we keep at the partner, how it's topped up (for example selling treasury USDC through an exchange to our own bank account), who approves top-ups, and the values of `PAYOUT_FLOAT_BUFFER_THB` and `OPS_MIN_PAYOUT_FLOAT_THB`.
- [ ] **PTR-5 [sign-off]** Onramp: a MoonPay production account, counsel's answer on Decree No. 2 (LEG-1), and a completed MoonPay sandbox purchase (still pending from iteration 8).
- [ ] **PTR-6 [sign-off]** The production exchange rate comes from the exchange partner's quote, with a guard against a rate that's stale or far from a second source ([API-9](security.md#52-backend-api-servicesapi)).
- [ ] **PTR-7 [sign-off]** A data processing agreement with every partner that receives personal data: payout partner, MoonPay, KYC vendor, Google (push), hosting, RPC provider.

## 3. Identity and compliance

- [ ] **CMP-1 [sign-off]** A **real KYC vendor** (Sumsub or Onfido) replaces `MockKycProvider`: passport, visa and a liveness check. Today the backend always uses the mock ([`container.ts`](../services/api/src/container.ts)), which approves everyone ([API-7](security.md#52-backend-api-servicesapi)).
- [ ] **CMP-2 [sign-off]** Verified names from KYC feed tap to pay's "verified" badge ([NFC-3](security.md#59-nfc-tap-to-pay-adr-0010)).
- [ ] **CMP-3 [sign-off]** Limits agreed with the partner and counsel: per payment and per day by tier ([`domain/user.ts`](../services/api/src/domain/user.ts) has demo values), and tap-to-pay limits (`P2P_MAX_AMOUNT_USDC` and the request caps).
- [ ] **CMP-4 [sign-off]** Sanctions screening of users at sign-up, and screening of incoming funds and payer wallets against on-chain risk data ([API-8](security.md#52-backend-api-servicesapi)).
- [ ] **CMP-5 [sign-off]** Transaction monitoring rules (structuring under limits, unusual velocity, many payers to one merchant), who reviews the alerts, and how a suspicious transaction is reported.
- [ ] **CMP-6 [auto]** Production refuses to start with `MERCHANT_QR_ONLY=false` (part of A7). Personal QRs stay refused, which also keeps payees' phone numbers off the chain ([SC-9](security.md#54-settlement-contract-contracts)).
- [ ] **CMP-7 [sign-off]** A way to block a user or a merchant ID quickly. It doesn't exist yet.

## 4. Smart contract and keys

- [ ] **CON-1 [sign-off]** An external **audit** of `GlobalPaySettlement`. Every finding is fixed or accepted in writing, and the deployed bytecode is the audited commit (verified on Basescan).
- [ ] **CON-2 [sign-off]** A decision on funds stuck by a USDC blacklist ([ADR 0006](adr/0006-immutable-settlement-contract.md), [WRK-11](security.md#53-workers-and-relayer)), made before the mainnet deployment, since the contract can't change afterwards.
- [ ] **CON-3 [sign-off]** Deployment set up for Base mainnet: a `base` RPC and verification entry in `foundry.toml`, the USDC address checked against Circle's list (Base mainnet: `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`), and either `Deploy.s.sol` taking the Safe as admin or the hand-over done right after deploying ([runbook](runbooks/key-rotation.md#admin-move-it-to-a-multisig)).
- [ ] **CON-4 [sign-off]** The **key ceremony** below is done and its record signed.
- [ ] **CON-5 [auto]** The deployment check (A12) passes on mainnet.
- [ ] **CON-6 [sign-off]** The contract-key rotations in the [runbook](runbooks/key-rotation.md) have been rehearsed on Base Sepolia: quote signer, relayer, pauser, admin to a Safe, treasury.
- [ ] **CON-7 [sign-off]** A pause has been rehearsed: the pauser pauses, the admin Safe unpauses, and the time it took is written down.

### Key ceremony

The aim: no single person can move funds or change roles, and there's a written record of every production key.

1. **Prepare.** At least three people: two key holders and someone who records. Hardware wallets bought new from the manufacturer. Agree the thresholds first, e.g. a 2-of-3 admin Safe and a separate treasury Safe.
2. **Signers.** Each signer sets up their hardware wallet and writes the recovery phrase on paper or steel, stored in its own secure place. No photos, no cloud.
3. **Safes.** Create the admin Safe and the treasury Safe on Base with those signers. Test one transaction from each.
4. **Backend keys.** Create the quote-signer and relayer keys in the KMS (secp256k1, not exportable). Only the backend's runtime identity may sign with them; no person can. This needs KMS signer support in the backend (SRV-4).
5. **Pauser.** A separate key that whoever is on call can reach at any hour (a hardware wallet, or a 1-of-N Safe of the on-call people).
6. **Deploy** with a fresh, throwaway deployer key. Grant the roles, allow USDC, hand admin to the Safe and renounce the deployer ([runbook](runbooks/key-rotation.md#admin-move-it-to-a-multisig)). Fund the relayer.
7. **Check** with A12. Commit the broadcast record as the deployment record.
8. **Record** the date, participants, every address and transaction hash, and *where* each recovery phrase is kept (never the phrase). Everyone present signs.

## 5. Backend and infrastructure

- [ ] **SRV-1 [auto]** Rate limits per IP and per user on public routes, webhooks and `/ops`, with tests ([API-5](security.md#52-backend-api-servicesapi)). Built in iteration 10: `test/rate-limits.test.ts`.
- [ ] **SRV-2 [auto]** Logs redact the `authorization`, `x-ops-token`, `x-callback-token` and `moonpay-signature-v2` headers and request bodies, with a test ([API-6](security.md#52-backend-api-servicesapi)). Built in iteration 10: `test/log-redaction.test.ts`, `test/redact.test.ts`.
- [ ] **SRV-3 [auto]** The indexer compares every `PaymentReceived` with its stored quote and holds a mismatch for an operator, with a test ([WRK-1](security.md#53-workers-and-relayer)). Built in iteration 10 (`event_mismatch` on `/ops`).
- [ ] **SRV-4 [sign-off]** The quote signer and relayer sign through the KMS, and relaying (`pay`, `transferWithAuthorization`) uses a different key from settling and refunding ([WRK-2](security.md#53-workers-and-relayer)).
- [ ] **SRV-5 [sign-off]** Hosting: TLS only; every secret in the [key inventory](runbooks/key-rotation.md#inventory) in a secret manager; Postgres encrypted at rest, backed up, a restore tested, reachable only from the backend; `/ops` reachable only over a VPN or from allowlisted IPs ([OPS-3](security.md#57-operator-console-ops)).
- [ ] **SRV-6 [sign-off]** Operators sign in as themselves (SSO with MFA), and marking a payout paid or approving a refund needs a second operator ([OPS-1, OPS-2](security.md#57-operator-console-ops)). If that isn't ready, a written exception: the shared token limited to named people and rotated whenever one leaves.
- [ ] **SRV-7 [sign-off]** A payouts-only stop switch, documented in the incident playbooks ([WRK-12](security.md#53-workers-and-relayer)).
- [ ] **SRV-8 [sign-off]** A contracted RPC provider; `INDEXER_CONFIRMATIONS` chosen for mainnet; large payouts cross-checked against a second RPC ([WRK-7, WRK-8](security.md#53-workers-and-relayer)).
- [ ] **SRV-9 [sign-off]** Crash reporting without personal data. Iteration 10 scrubs every logged error (`src/shared/logging.ts`); ship error-level logs to the chosen tracker and check a sample.
- [ ] **SRV-10 [sign-off]** Stuck transactions are replaced with a higher fee ([WRK-6](security.md#53-workers-and-relayer)).

## 6. Mobile app and store release

- [ ] **MOB-1 [auto]** A8–A11 pass on the build being submitted.
- [ ] **MOB-2 [sign-off]** The Privy wallet (iteration 11) is the default `WalletService`; `DevWalletService` is used only in tests ([APP-1, APP-8](security.md#51-mobile-app-appsmobile)).
- [ ] **MOB-3 [sign-off]** Android backup is off for the app's data, and a Play Integrity check runs at sign-in ([APP-2](security.md#51-mobile-app-appsmobile)).
- [ ] **MOB-4 [sign-off]** Play App Signing is set up, the upload key is in the team vault, and the Play Console account uses MFA ([runbook](runbooks/key-rotation.md#app-release-signing-key)).
- [ ] **MOB-5 [sign-off]** Device key attestation is checked when a phone registers for tap to pay ([NFC-2](security.md#59-nfc-tap-to-pay-adr-0010)).
- [ ] **MOB-6 [sign-off]** Google Play's requirements:
  - the target API level Play currently requires;
  - a Data safety form that matches [section 7](#7-data-protection-pdpa);
  - a privacy policy URL;
  - account deletion, both in the app and through a web link;
  - the financial features declaration, and Play's policy on cryptocurrency exchanges and software wallets (check its country-specific licensing rules for Thailand);
  - the notification permission (Android 13+) and NFC use explained to the user;
  - a review account that works without real money.
- [ ] **MOB-7 [sign-off]** Tested on real phones: a tap between two NFC phones, push arriving with the app closed, and the Add-money Custom Tab (pending from iterations 8 and 9). With Privy: sign-in and every payment ask for the fingerprint, cancelling signs nothing, and changing the phone's fingerprints asks for an email sign-in before the next signature ([APP-1](security.md#51-mobile-app-appsmobile)).
- [ ] **MOB-8 [sign-off]** The first release is Android only. An iOS app needs its own security review first.

## 7. Data protection (PDPA)

Thailand's Personal Data Protection Act B.E. 2562 (2019) has applied in full since 1 June 2022.

- [ ] **DP-1 [sign-off]** A record of processing that lists what we hold and why:
  - wallet addresses and display names;
  - KYC results (the documents stay with the vendor);
  - quotes with the raw QR, which for a personal QR holds a third party's phone number or national ID;
  - payment, deposit and onramp history;
  - device public keys and push tokens;
  - client IP addresses in logs;
  - operator names in `OpsAction`;
  - partner webhook bodies in `PayoutEvent`.
- [ ] **DP-2 [sign-off]** A lawful basis for each (the contract with the user, legal obligations for KYC and AML, consent where needed), and a privacy notice in the app and on the web.
- [ ] **DP-3 [sign-off]** Biometrics: fingerprints never leave the phone. Android checks them (`BiometricPrompt`) and we store nothing. The KYC vendor's face and liveness data is sensitive data under the PDPA: explicit consent, and covered by the vendor's agreement.
- [ ] **DP-4 [sign-off]** Transfers abroad (KYC vendor, MoonPay, Google, hosting outside Thailand) have the safeguards the PDPA requires.
- [ ] **DP-5 [sign-off]** A process and an owner for access, correction, deletion and portability requests. The privacy notice says that on-chain data (wallet addresses, amounts, merchant hashes) can't be deleted, so as little as possible goes on-chain ([SC-9](security.md#54-settlement-contract-contracts)).
- [ ] **DP-6 [sign-off]** Retention periods for each kind of data, balancing AML record-keeping against PDPA minimisation, and a job that deletes or anonymises after them (logs, webhook bodies, raw QR payloads).
- [ ] **DP-7 [sign-off]** A decision on whether a data protection officer is required, and an appointment if so.
- [ ] **DP-8 [auto]** Log redaction (SRV-2) and crash reports without personal data (SRV-9).
- [ ] **DP-9 [sign-off]** A breach procedure: tell the regulator (the PDPC) within 72 hours of learning of a breach, unless it's unlikely to put people at risk; tell affected people without delay when the risk is high.

## 8. Incident response

- [ ] **IR-1 [sign-off]** An on-call rota, with at least two people who can act at any hour, and the pauser key within their reach.
- [ ] **IR-2 [sign-off]** Severity levels, for example: 1 = funds at risk or a key leaked; 2 = payments failing; 3 = degraded.
- [ ] **IR-3 [sign-off]** Written playbooks, each rehearsed at least once as a tabletop exercise:
  - a leaked key: the runbook's [If a key leaks](runbooks/key-rotation.md#if-a-key-leaks);
  - stopping things: new payments (`pause()`), payouts (SRV-7; today, stop the API or unset `RELAYER_PRIVATE_KEY`), tap to pay (not stopped by a pause);
  - a payout partner outage (payments wait in PAYOUT_PENDING; unclear payouts follow [ADR 0008](adr/0008-payout-outcomes-and-reconciliation.md));
  - a Base sequencer or RPC outage;
  - USDC losing its peg, or Circle freezing an address;
  - a personal-data breach (DP-9);
  - a fraud wave through mule merchants (block them: CMP-7; lower limits).
- [ ] **IR-4 [sign-off]** A contact list: payout partner support, MoonPay, KYC vendor, Circle, hosting, counsel, the PDPC.
- [ ] **IR-5 [sign-off]** Message templates for users (an in-app banner or status page).
- [ ] **IR-6 [sign-off]** A post-incident review template.

## 9. Monitoring and alerting

- [ ] **MON-1 [auto]** An external monitor polls `/health` and `/ops/api/health` (with the operator token) every minute and pages whoever is on call when `alerts` isn't empty. The health check already raises alerts for a low payout float, an unreachable partner, low relayer gas, a missing relayer key, an unreachable chain, and UNKNOWN or reversed payouts ([`ops/service.ts`](../services/api/src/modules/ops/service.ts)). Nothing polls it today ([OPS-6](security.md#57-operator-console-ops)).
- [ ] **MON-2 [sign-off]** Mainnet thresholds: `OPS_MIN_RELAYER_ETH` covers at least a day of gas, and `OPS_MIN_PAYOUT_FLOAT_THB` covers several hours of peak payouts.
- [ ] **MON-3 [auto]** Escalated `/ops` exceptions (paid without a payout, UNKNOWN past `OPS_ESCALATE_AFTER_MS`, reversals, conflicts) page someone.
- [ ] **MON-4 [auto]** Contract events page someone: `RoleGranted`, `RoleRevoked`, `TreasuryUpdated`, `TokenAllowed`, `Paused`, `Unpaused`, and any `PaymentSettled` or `PaymentRefunded` the worker didn't send ([SC-5, WRK-2](security.md#54-settlement-contract-contracts)).
- [ ] **MON-5 [auto]** Stuck onramp orders, failed tap-to-pay transfers, and FAILED payments later paid on-chain appear on `/ops` ([WRK-10](security.md#53-workers-and-relayer)).
- [ ] **MON-6 [sign-off]** A daily reconciliation: the partner's statement against `Payout` rows and on-chain settlements, and the treasury balance against settled payments.
- [ ] **MON-7 [sign-off]** Dashboards: payments by status, time to settle, refunds, and the UNKNOWN rate.

## 10. Go-live: the controlled 1-baht payment

The last step. Everything above is done or waived; the contract is on Base mainnet; the partner is live; limits are set low.

1. **Allow one merchant only.** There's no merchant allowlist today (`MERCHANT_QR_ONLY` filters by QR type only). Add one, or keep the API reachable only from the team's phones for this step.
2. **Pay.** A team member with real KYC holds a few USDC and pays **1.00 THB** to a merchant account the team controls at the partner.
3. **Check every link** (each one **[sign-off]**, with the evidence attached):
   - `pay` on Basescan, and the `PaymentReceived` fields equal the stored quote;
   - the payout is SUCCEEDED with the partner's bank reference;
   - the merchant account received 1.00 THB with that reference;
   - `markSettled` sent the USDC to the treasury Safe;
   - the app shows "Merchant paid" with the reference;
   - `PayoutEvent` has every partner answer, and `/ops/api/health` has no alerts.
4. **Refund path.** If the partner offers a safe way to force a definite failure in production, run one and check the `refund` returns the USDC. Otherwise rely on the Base Sepolia run.
5. **Reconcile** the partner statement, the treasury balance and the database.
6. **Sign off** (engineering lead, compliance lead, project owner). Then raise limits step by step and open the merchant allowlist.

## Sign-off

| Area | Owner | Signed (name, date) | Evidence |
|---|---|---|---|
| Automated checks (A1–A16) | Engineering lead | | CI run |
| 1. Legal and regulatory | Project owner + counsel | | Legal opinion |
| 2. Partners | Project owner | | Contracts |
| 3. Identity and compliance | Compliance lead | | Vendor contract, policies |
| 4. Smart contract and keys | Engineering lead | | Audit report, ceremony record |
| 5. Backend and infrastructure | Engineering lead | | |
| 6. Mobile app and store release | App lead | | Play Console |
| 7. Data protection | Data protection owner | | Record of processing, privacy notice |
| 8. Incident response | Engineering lead | | Playbooks, tabletop notes |
| 9. Monitoring and alerting | Engineering lead | | Test page |
| 10. The 1-baht payment | All three | | Transaction hashes, partner statement |
