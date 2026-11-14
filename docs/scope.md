# Product scope

GlobalPay lets people hold stablecoins and pay any local merchant QR code. The merchant receives local currency and never touches crypto. A card on the same balance covers places without QR payments.

## Why the idea is strong

The merchant doesn't have to sign up. GlobalPay pays QR codes that merchants already display, and UPI alone covers tens of millions of merchants. The technology is a small part of the work. Most of it is licences, banking partners, keeping enough local currency on hand, and anti-money-laundering (AML) controls.

**One reframe:** this isn't DeFi. The moment a stablecoin turns into local currency is regulated, custodial and needs KYC. The wallet can stay non-custodial, but the conversion is centralised. We describe the product as **stablecoin payments**.

## How the bridge works

1. The user scans a merchant QR, and the app reads it.
2. The backend locks a quote for about 60 seconds (exchange rate plus fee).
3. The user's stablecoins move to the GlobalPay settlement contract.
4. GlobalPay pays the merchant in local currency from a pre-funded pool, through a licensed payout partner.
5. GlobalPay later sells the stablecoins through an OTC desk to top the pool back up.

The pre-funded pool is needed in every country. That makes it capital-intensive, and also hard for competitors to copy.

## Product modules

| Module | Covers | Build or partner |
|---|---|---|
| Wallet | USDC/USDT on EVM chains, embedded wallet, gas paid for the user | Build on a provider SDK |
| QR payment engine | Readers for PromptPay, UPI, QRIS, VietQR, QR Ph and PIX; rate lock; receipts | **Build (core technology)** |
| Treasury and liquidity | Local-currency pool per country, OTC top-ups, currency hedging, protection if a stablecoin loses its peg | Build the logic; partner with OTC desks |
| Local payout rails | Licensed payment aggregator, bank or e-money operator per country | Partner |
| Card | Visa/Mastercard through an issuer and program manager; Apple/Google Pay | Partner |
| Compliance | KYC/KYB, on-chain screening, sanctions checks, Travel Rule, transaction monitoring, tax reporting | Partner tools plus an in-house team |
| Risk and fraud | Limits, device binding, checking that a QR belongs to a real merchant | Build |
| Later | Remittances, credit backed by crypto, savings, merchant dashboard, B2B API | Later |

## Markets

| Market | QR rail | Verdict |
|---|---|---|
| Thailand | PromptPay | **First market.** A 2025 sandbox lets foreign tourists convert crypto to baht for spending. |
| India | UPI | Biggest prize, hardest place to start: 30% tax on gains, 1% TDS on transfers, FIU-IND registration, RBI scepticism of stablecoins, and banks and NPCI are wary of crypto money. |
| Brazil | PIX | Heavy USDT use and existing crypto-to-PIX apps. Demand is proven, but the market is crowded. |
| Philippines, Vietnam, Indonesia | QR Ph, VietQR, QRIS | Regulation is opening up. Second wave. |
| EU | — | MiCA rules mean USDC rather than USDT. Lead with the card. |

### India specifics

- **Residents:** every USDT-to-INR sale is a crypto transfer, so 1% TDS is withheld and it has to be reported. That makes everyday spending impractical.
- **Foreign visitors:** converting their crypto to INR inside India, outside the authorised-dealer (AD) banks, breaks FEMA. A clean structure:
  1. Convert the crypto offshore through a licensed entity.
  2. Send the money into India through an AD bank as normal incoming foreign currency.
  3. Load it into a licensed Indian prepaid wallet, the way UPI One World works.
  4. The user pays UPI QRs from that wallet.
- **Merchant fees:** UPI charges merchants nothing, so all revenue has to come from the exchange-rate spread.

## Biggest risk: becoming a money-laundering pipe

If the app can pay any account, people will use it to turn crypto into cash in mule accounts. Controls built into the design:

- Merchant QRs only (P2M): baht goes only to merchants, never to a personal PromptPay account (`MERCHANT_QR_ONLY`, forced on in production).
- Limits per payment and per day, based on KYC tier.
- On-chain screening of incoming funds.

## Chosen direction: stablecoin freelancers, Thailand first

**Who:** foreign remote workers living in Thailand (DTV-visa holders and nomads in Bangkok, Chiang Mai and Phuket) whose overseas clients pay them in USDC or USDT.

Thai-resident freelancers are out of scope for now. Thailand has restricted licensed crypto businesses from supporting crypto as a means of payment since 2022, and the 2025 sandbox makes an exception only for foreigners.

**Their pain today:**
- They cash out through P2P traders or an exchange plus a bank transfer. It's slow, with fees at every step.
- Opening a Thai bank account as a foreigner is hard, so many can't use PromptPay at all.
- Foreign cards cost about 220 baht per ATM withdrawal, plus FX markup.

**How it works in Thailand (through partners):**
1. A licensed Thai crypto exchange converts the stablecoins to baht.
2. A licensed e-money operator holds the baht and pays the merchant's PromptPay QR.
3. GlobalPay provides the app, wallet, rate lock and compliance layer.

**First version scope:**
- KYC with passport and visa.
- A stablecoin deposit address per user, plus payment-request links.
- Scan a PromptPay QR and pay in baht at a locked rate.
- A partner debit card.
- Income and spending statements.

**Out of scope for now:** Thai residents, baht payouts to individuals (personal PromptPay accounts), credit, savings/yield, other countries.

Tap to pay (iteration 9) is different: it moves USDC between two GlobalPay wallets, and no baht leaves the system. Both sides must pass KYC, and it has its own limits (per request, per day per sender). It still needs the same AML review before real money.

**Next markets:** Indonesia (QRIS), Vietnam (VietQR), then India through the offshore + prepaid-wallet structure.

## Open questions to check before launch

- Does the Thai sandbox cover long-stay foreigners on DTV visas, or only short-term tourists? What are the caps and the duration?
- Which licensed exchanges and e-money operators are already in the sandbox?
- Tax: Thai tax residents (180+ days a year) owe tax on foreign income brought into Thailand. Statements should help users with this.

Regulatory points reflect information available at the time of writing. Confirm them with fintech counsel in each country before committing.
