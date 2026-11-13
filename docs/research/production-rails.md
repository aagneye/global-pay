# Research: production rails (November 2026)

What it takes to turn the demo into a product: a real THB payout, a way to add money, and tap-to-pay between people. Researched 2026-11-13 from public developer docs. Prices, coverage and terms change; confirm with each provider before signing.

The plan built on this is in the [roadmap](../roadmap.md) (iterations 6–11).

## 1. Paying the merchant in baht

GlobalPay must pay two kinds of PromptPay QR:
- **Tag 29:** a credit transfer to a person, by mobile number, national ID or e-wallet ID.
- **Tag 30:** a bill payment to a registered biller, with a biller ID and reference 1/2. Many shop QRs are this kind.

| Rail | Pays tag 29 | Pays tag 30 | Idempotency | Final statuses | Webhook auth | Sandbox |
|---|---|---|---|---|---|---|
| **Xendit** payouts v2 | "Local – PromptPay" rail; accepted ID types not documented | No | `Idempotency-key` header (required) | SUCCEEDED (can later become REVERSED), FAILED, CANCELLED | Static `x-callback-token` | Yes, self-serve, with forced-failure test accounts |
| **Opn (Omise)** transfers | Bank accounts only | No | `idemp_key` body field | `paid`, or `failure_code` | HMAC-SHA256 `Omise-Signature` | Yes |
| **Airwallex** transfers | Bank account over PromptPay | No | `request_id` | paid, failed, cancelled | HMAC `x-signature` | Yes |
| **Krungsri** corporate API | **Yes** (mobile, national ID, tax ID, e-wallet) | **Yes** (bill payment with ref1/ref2, plus a QR parser) | Not documented | Not published | Not documented | Not described |
| **SCB** | Citizen/tax ID proxy | Not found | `RQUID` | CONFIRM_COMPLETED / FAILED / CANCELED | Not found | `api-sandbox.partners.scb` |
| KBank, 2C2P, Rapyd, Thunes, Nium, Wise, dLocal, Ripple | No public PromptPay payout docs (dLocal: bank or TrueMoney; Ripple: bank account) | No | | | | |

**Decision:** build against **Xendit** in sandbox, behind a provider-neutral payout port; target **Krungsri** (or a licensed partner) for production.

### Xendit payouts (v2)

| Call | Endpoint |
|---|---|
| Create | `POST https://api.xendit.co/v2/payouts`, Basic auth with the secret key, header `Idempotency-key: <our key>`. Body: `reference_id`, `channel_code`, `channel_properties {account_holder_name, account_number}`, `amount`, `currency: THB` |
| Get | `GET /v2/payouts/{id}` |
| Find by our reference | `GET /v2/payouts?reference_id=...` |
| Cancel (only while ACCEPTED) | `POST /v2/payouts/{id}/cancel` |
| Channels | `GET /payouts_channels?currency=THB` |
| Webhooks | `payout.succeeded`, `payout.failed`, `payout.reversed`, with a static `x-callback-token` header |

Same idempotency key with the same body returns the original payout; a different body returns `DUPLICATE_ERROR`.

| Xendit status | GlobalPay payout status |
|---|---|
| ACCEPTED, REQUESTED | PENDING |
| SUCCEEDED | SUCCEEDED (watch for a later REVERSED) |
| FAILED, CANCELLED | FAILED (definite: refund) |
| REVERSED | REVERSED (operator case) |
| Timeout, 5xx, unparseable, or pending past the deadline | UNKNOWN (never settle or refund automatically) |

Because the webhook token is static, GlobalPay re-fetches the payout before acting on a webhook.

Sources: [Thailand coverage](https://docs.xendit.co/docs/payouts-thailand), [status lifecycle](https://docs.xendit.co/docs/payout-status-lifecycle.md), [test scenarios](https://docs.xendit.co/docs/test-scenarios-payouts.md), [webhooks](https://docs.xendit.co/docs/handling-webhooks.md), [Node SDK reference](https://cdn.jsdelivr.net/npm/xendit-node@7.0.0/docs/Payout.md).

### Krungsri (production target)

- Fund transfer: `POST /rest/api/v4/.../fundTransfer/initiation`, then `/confirmation`; inquiry `GET /rest/api/v3/.../fundTransfer/inquiry/{transactionInitiationNumber}`. Returns `transactionInitiationNumber` and `paymentReferenceIdentification`.
- Bill payment with `billReference1/2`, and a QR parser.
- Needs a Thai company and a Krungsri account.

Sources: [fund transfer](https://developers.krungsri.com/usecases/financial-services/fund-transfer), [pay bill](https://developers.krungsri.com/usecases/financial-services/corporate-pay-bill).

### Regulation

- **Since 1 April 2022** the Thai SEC bars licensed digital-asset businesses from supporting crypto as a means of payment ([Baker McKenzie](https://blockchain.bakermckenzie.com/2022/03/27/thai-sec-bans-cryptocurrency-as-a-means-of-payment)).
- A payment service needs a licence under the Payment Systems Act, through a Thai company ([LawPlus](https://www.lawplusltd.com/2017/12/thailand-new-payment-system-law/)).
- **TouristDigiPay** (from 18 Aug 2025, 18 months): foreign tourists convert crypto at an SEC-licensed exchange into a Bank of Thailand e-money wallet; 50k THB/month at small merchants, 500k at verified ones ([Tilleke](https://www.tilleke.com/insights/thailand-launches-initiative-supporting-digital-asset-use-in-tourism/)). Participants publish no APIs.

So the production rail needs a licensed partner, found through business development, and a Thai legal opinion.

### Treasury

Bitkub's API (HMAC-signed) can sell USDC and withdraw THB, but only to our own bank account: useful for topping up the payout float, not for paying merchants ([Bitkub API](https://api.bitkub.com/docs)).

## 2. Add money (onramp)

| Provider | Thailand | USDC on Base | Notes |
|---|---|---|---|
| **MoonPay** | Buying allowed; THB from 800 | `usdc_base` | Signed widget URL; signed webhooks; sandbox delivers on Sepolia, not Base |
| Coinbase Onramp | Unclear (only where Coinbase operates) | Yes | Session API; zero-fee USDC on request |
| Transak | Not listed | Yes | No Flutter support |
| Ramp | Unsupported | | |
| Stripe | US and EU only | Not documented | |
| Thai payment gateway + we sell USDC | Needs a Thai SEC licence | | Omise won't onboard it |

**Decision:** MoonPay (sandbox first), plus "deposit from another wallet" for everyone.

### MoonPay

1. Backend creates an order and builds `https://buy.moonpay.com?apiKey=...&currencyCode=usdc_base&walletAddress=<from our database>&baseCurrencyCode=thb&baseCurrencyAmount=...&externalTransactionId=<orderId>&redirectURL=<https link>`, signed with HMAC-SHA256 of the query (`signature` last).
2. The app opens it in a Custom Tab (not a WebView).
3. Webhooks `transaction_created/updated/failed` with `Moonpay-Signature-V2: t=..,s=..` (HMAC-SHA256 of `t.rawBody`). At-least-once and unordered: dedupe, then re-fetch `GET /v1/transactions/ext/{orderId}`.
4. Statuses: `waitingPayment`, `waitingAuthorization`, `pending`, then `completed` or `failed`. No expiry status: GlobalPay times orders out itself.
5. "Received" only after a USDC `Transfer` to the user's address for the right amount is confirmed on-chain, each transfer counted once.

Sources: [signed URLs](https://dev.moonpay.com/docs/on-ramp-enhance-security-using-signed-urls), [parameters](https://dev.moonpay.com/widget/on-ramp/customization/parameters), [transaction](https://dev.moonpay.com/api-reference/widget/getbuytransaction), [webhook signature](https://dev.moonpay.com/api-reference/widget/webhooks/signature), [sandbox](https://dev.moonpay.com/widget/sandbox-testing), [countries](https://api.moonpay.com/v3/countries).

Legal risk: Thailand's Decree No. 2 (2025) extends licensing to offshore digital-asset services for people in Thailand, and the SEC is enforcing it ([Tilleke](https://www.tilleke.com/insights/thai-sec-heightens-enforcement-against-cross-border-digital-asset-platforms/)). Get counsel before launch.

## 3. Tap to pay

### What Tap2ETH does

[Tap2ETH](https://github.com/team-somehow/tap2eth) (ETHGlobal) uses the bank card as a **signer**: EMV DDA `INTERNAL AUTHENTICATE` over a 4-byte challenge, 1024-bit RSA, verified on-chain with the modexp precompile, plus a fingerprint-locked P-256 phone key. Only cards with DDA work, and only one real card was verified. Reading cards puts the receiving phone in PCI DSS scope, and "hold your card to a phone" is the pattern NGate malware abused.

### GlobalPay's design

- **Phone to phone (default).** The sender's phone emulates an NFC card (Android HCE, our own AID). The receiver's phone sends a one-time challenge from the backend; the sender's phone signs it with a P-256 Android Keystore key registered to its account. That identifies the sender without any card data.
- **QR fallback** with a signed request ID (also works on iPhone).
- **Push:** FCM HTTP v1 (`firebase-admin`), a visible generic notification plus `data: {requestId}`, high priority. Android 13+ needs the notification permission.
- **Approval:** the app fetches the request (amount and the recipient's server-side verified name), the user confirms with biometrics, and signs USDC `transferWithAuthorization` (EIP-712). The backend checks it against the stored request and relays it. (`receiveWithAuthorization` can't be used: the caller must be the payee.)
- **Biometric-bound key:** Android Keystore can't hold secp256k1, so the wallet key is encrypted with a Keystore AES key that needs biometrics on every use (BiometricPrompt with a CryptoObject). `local_auth` alone is bypassable.
- **Bank-card tap:** deferred until a PCI review.

Sources: [Android HCE](https://developer.android.com/develop/connectivity/nfc/hce), [IsoDep](https://developer.android.com/reference/android/nfc/tech/IsoDep), [nfc_manager](https://pub.dev/packages/nfc_manager), [FCM v1](https://firebase.google.com/docs/cloud-messaging/send/v1-api), [FCM Flutter](https://firebase.google.com/docs/cloud-messaging/flutter/receive), [message priority](https://firebase.google.com/docs/cloud-messaging/android/message-priority), [Keystore](https://developer.android.com/privacy-and-security/keystore), [biometric auth](https://developer.android.com/identity/sign-in/biometric-auth), [EIP-3009](https://eips.ethereum.org/EIPS/eip-3009), [USDC addresses](https://developers.circle.com/stablecoins/usdc-contract-addresses).
