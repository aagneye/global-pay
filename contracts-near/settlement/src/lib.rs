//! GlobalPay settlement contract on NEAR: the NEAR twin of `contracts/src/GlobalPaySettlement.sol`.
//!
//! It holds a NEP-141 stablecoin payment from the moment the user pays until GlobalPay's
//! local-currency payout either succeeds (`settle`: the tokens go to the treasury) or fails
//! (`refund`: the tokens go back to the payer).
//!
//! 1. The payer calls `ft_transfer_call` on the token with this contract as `receiver_id` and
//!    a `msg` holding a quote signed by GlobalPay's quote key (see [`quote`]).
//! 2. The token calls [`Settlement::ft_on_transfer`]. Every check passes, or it panics and the
//!    token refunds the payer. On success the payment is recorded as Paid and a
//!    `payment_received` event is logged.
//! 3. The operator calls [`Settlement::settle`] or [`Settlement::refund`].
//!
//! Not upgradeable, like the EVM contract (docs/adr/0006). Storage is paid from this account's
//! own NEAR balance (about 0.005 NEAR per payment), so keep it funded.

pub mod events;
pub mod quote;

use near_sdk::borsh::BorshSerialize;
use near_sdk::json_types::U128;
use near_sdk::store::{LookupMap, Vector};
use near_sdk::{
    env, ext_contract, near, require, AccountId, BorshStorageKey, Gas, NearToken, PanicOnDefault,
    Promise, PromiseError, PromiseOrValue,
};

use events::PayoutData;
use quote::{check_transfer, normalize_hex32, parse_ed25519_public_key, Transfer};

/// Gas for the token's `ft_transfer`.
pub const GAS_FOR_FT_TRANSFER: Gas = Gas::from_tgas(15);
/// Gas for [`Settlement::on_payout`].
pub const GAS_FOR_ON_PAYOUT: Gas = Gas::from_tgas(10);
/// `settle` and `refund` refuse less prepaid gas, so the rollback callback always gets to run.
pub const MIN_GAS_FOR_PAYOUT: Gas = Gas::from_tgas(40);

#[derive(BorshSerialize, BorshStorageKey)]
#[borsh(crate = "near_sdk::borsh")]
enum StorageKey {
    Payments,
    PaidLog,
}

#[near(serializers = [borsh])]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PaymentStatus {
    Paid,
    Settled,
    Refunded,
}

impl PaymentStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Paid => "Paid",
            Self::Settled => "Settled",
            Self::Refunded => "Refunded",
        }
    }
}

/// A payment as stored, keyed by its quote id.
#[near(serializers = [borsh])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Payment {
    pub payer: AccountId,
    pub token: AccountId,
    pub token_amount: u128,
    pub fiat_currency: String,
    pub fiat_amount: u128,
    pub merchant_ref_hash: String,
    pub status: PaymentStatus,
    pub paid_block: u64,
    /// Position in the paid log (0, 1, 2, ...).
    pub index: u64,
}

/// A payment as returned by views and the `payment_received` event.
#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PaymentView {
    pub quote_id: String,
    pub payer: AccountId,
    pub token: AccountId,
    pub token_amount: U128,
    pub fiat_currency: String,
    pub fiat_amount: U128,
    pub merchant_ref_hash: String,
    /// "Paid", "Settled" or "Refunded".
    pub status: String,
    pub paid_block: u64,
    pub index: u64,
}

impl PaymentView {
    fn new(quote_id: &str, payment: &Payment) -> Self {
        Self {
            quote_id: quote_id.to_owned(),
            payer: payment.payer.clone(),
            token: payment.token.clone(),
            token_amount: U128(payment.token_amount),
            fiat_currency: payment.fiat_currency.clone(),
            fiat_amount: U128(payment.fiat_amount),
            merchant_ref_hash: payment.merchant_ref_hash.clone(),
            status: payment.status.as_str().to_owned(),
            paid_block: payment.paid_block,
            index: payment.index,
        }
    }
}

#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ConfigView {
    pub owner: AccountId,
    pub operator: AccountId,
    pub treasury: AccountId,
    pub token: AccountId,
    pub quote_signer_pk: String,
}

/// Which way the held tokens go.
#[near(serializers = [json])]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Payout {
    Settle,
    Refund,
}

impl Payout {
    fn as_str(self) -> &'static str {
        match self {
            Self::Settle => "settle",
            Self::Refund => "refund",
        }
    }
}

/// The NEP-141 method this contract calls on the token.
#[ext_contract(ext_ft)]
#[allow(dead_code)]
trait FungibleTokenCore {
    fn ft_transfer(&mut self, receiver_id: AccountId, amount: U128, memo: Option<String>);
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Settlement {
    owner: AccountId,
    operator: AccountId,
    treasury: AccountId,
    token: AccountId,
    quote_signer_pk: String,
    quote_signer_key: [u8; 32],
    payments: LookupMap<String, Payment>,
    /// Quote ids in the order they were paid. Append-only.
    paid_log: Vector<String>,
}

#[near]
impl Settlement {
    /// `quote_signer_pk` is `ed25519:<base58 of 32 bytes>`.
    #[init]
    pub fn new(
        owner: AccountId,
        operator: AccountId,
        treasury: AccountId,
        token: AccountId,
        quote_signer_pk: String,
    ) -> Self {
        let quote_signer_key = parse_ed25519_public_key(&quote_signer_pk)
            .unwrap_or_else(|e| env::panic_str(&e.to_string()));
        Self {
            owner,
            operator,
            treasury,
            token,
            quote_signer_pk,
            quote_signer_key,
            payments: LookupMap::new(StorageKey::Payments),
            paid_log: Vector::new(StorageKey::PaidLog),
        }
    }

    // ------------------------------------------------------------------ payments

    /// NEP-141 receiver. Records the payment and keeps all the tokens, or panics so the token
    /// refunds the sender. `msg` is `{"quote":"<quote json>","signature":"<base64>"}`.
    pub fn ft_on_transfer(
        &mut self,
        sender_id: AccountId,
        amount: U128,
        msg: String,
    ) -> PromiseOrValue<U128> {
        let caller = env::predecessor_account_id();
        require!(caller == self.token, "only the configured token can call ft_on_transfer");

        let transfer = Transfer {
            sender_id: &sender_id,
            token: &caller,
            amount: amount.0,
            now_ms: env::block_timestamp_ms(),
        };
        let quote = check_transfer(&msg, &self.quote_signer_key, &transfer, |sig, message, pk| {
            env::ed25519_verify(sig, message, pk)
        })
        .unwrap_or_else(|e| env::panic_str(&e.to_string()));
        if self.payments.contains_key(&quote.quote_id) {
            env::panic_str(&format!("quote already used: {}", quote.quote_id));
        }

        let payment = Payment {
            payer: quote.payer,
            token: quote.token,
            token_amount: quote.token_amount,
            fiat_currency: quote.fiat_currency,
            fiat_amount: quote.fiat_amount,
            merchant_ref_hash: quote.merchant_ref_hash,
            status: PaymentStatus::Paid,
            paid_block: env::block_height(),
            index: u64::from(self.paid_log.len()),
        };
        events::payment_received(&PaymentView::new(&quote.quote_id, &payment));
        self.payments.insert(quote.quote_id.clone(), payment);
        self.paid_log.push(quote.quote_id);

        PromiseOrValue::Value(U128(0))
    }

    /// Operator only. Paid -> Settled, then sends the tokens to the treasury. Attach at least
    /// 40 TGas. The call's final value is `true` once the tokens moved, or `false` if the
    /// transfer failed and the payment went back to Paid.
    pub fn settle(&mut self, quote_id: String) -> Promise {
        self.payout(quote_id, Payout::Settle)
    }

    /// Operator only. Paid -> Refunded, then sends the tokens back to the payer. Attach at
    /// least 40 TGas. Returns like [`Settlement::settle`].
    pub fn refund(&mut self, quote_id: String) -> Promise {
        self.payout(quote_id, Payout::Refund)
    }

    /// Callback of the payout's `ft_transfer`. On failure it rolls the payment back to Paid so
    /// the operator can try again.
    #[private]
    pub fn on_payout(&mut self, quote_id: String, payout: Payout) -> bool {
        let transferred = !matches!(env::promise_result_checked(0, 64), Err(PromiseError::Failed));
        let treasury = self.treasury.clone();
        let payment = self
            .payments
            .get_mut(&quote_id)
            .unwrap_or_else(|| env::panic_str(&format!("unknown quote: {quote_id}")));
        let receiver_id = match payout {
            Payout::Settle => &treasury,
            Payout::Refund => &payment.payer,
        };
        let data = PayoutData {
            quote_id: &quote_id,
            action: payout.as_str(),
            token: &payment.token,
            receiver_id,
            token_amount: U128(payment.token_amount),
        };
        match (transferred, payout) {
            (true, Payout::Settle) => events::settled(data),
            (true, Payout::Refund) => events::refunded(data),
            (false, _) => {
                events::payout_failed(data);
                payment.status = PaymentStatus::Paid;
            }
        }
        transferred
    }

    // --------------------------------------------------------------------- admin

    /// Owner only.
    pub fn set_operator(&mut self, account: AccountId) {
        self.assert_owner();
        self.operator = account;
    }

    /// Owner only. `pk` is `ed25519:<base58 of 32 bytes>`. Quotes signed by the old key stop
    /// being accepted at once.
    pub fn set_quote_signer(&mut self, pk: String) {
        self.assert_owner();
        self.quote_signer_key =
            parse_ed25519_public_key(&pk).unwrap_or_else(|e| env::panic_str(&e.to_string()));
        self.quote_signer_pk = pk;
    }

    // --------------------------------------------------------------------- views

    pub fn get_payment(&self, quote_id: String) -> Option<PaymentView> {
        let quote_id = normalize_hex32(&quote_id, "quote_id").ok()?;
        self.payments.get(&quote_id).map(|payment| PaymentView::new(&quote_id, payment))
    }

    /// How many payments were ever received. The backend's indexer cursor.
    pub fn paid_count(&self) -> u64 {
        u64::from(self.paid_log.len())
    }

    /// Payments in the order they were paid, from `from_index`, at most `limit` of them.
    /// `status` is the current status. Keep `limit` around 100 to stay within view gas.
    pub fn get_paid_events(&self, from_index: u64, limit: u64) -> Vec<PaymentView> {
        let len = self.paid_count();
        let start = from_index.min(len);
        let end = start.saturating_add(limit).min(len);
        (start..end)
            .map(|i| {
                // `end <= len`, and `len` came from a u32.
                let quote_id = &self.paid_log[i as u32];
                let payment = self.payments.get(quote_id).unwrap_or_else(|| env::abort());
                PaymentView::new(quote_id, payment)
            })
            .collect()
    }

    pub fn get_config(&self) -> ConfigView {
        ConfigView {
            owner: self.owner.clone(),
            operator: self.operator.clone(),
            treasury: self.treasury.clone(),
            token: self.token.clone(),
            quote_signer_pk: self.quote_signer_pk.clone(),
        }
    }
}

impl Settlement {
    fn assert_owner(&self) {
        require!(env::predecessor_account_id() == self.owner, "only the owner can call this");
    }

    fn assert_operator(&self) {
        require!(env::predecessor_account_id() == self.operator, "only the operator can call this");
    }

    /// Checks-effects-interactions: the status changes before the token call, and
    /// [`Settlement::on_payout`] puts it back if the transfer fails.
    fn payout(&mut self, quote_id: String, payout: Payout) -> Promise {
        self.assert_operator();
        require!(
            env::prepaid_gas() >= MIN_GAS_FOR_PAYOUT,
            "attach at least 40 TGas so the payout callback can run"
        );
        let quote_id = normalize_hex32(&quote_id, "quote_id")
            .unwrap_or_else(|e| env::panic_str(&e.to_string()));
        let treasury = self.treasury.clone();
        let payment = self
            .payments
            .get_mut(&quote_id)
            .unwrap_or_else(|| env::panic_str(&format!("unknown quote: {quote_id}")));
        if payment.status != PaymentStatus::Paid {
            env::panic_str(&format!(
                "payment {quote_id} is {}, not Paid",
                payment.status.as_str()
            ));
        }
        let receiver_id = match payout {
            Payout::Settle => {
                payment.status = PaymentStatus::Settled;
                treasury
            }
            Payout::Refund => {
                payment.status = PaymentStatus::Refunded;
                payment.payer.clone()
            }
        };

        ext_ft::ext(payment.token.clone())
            .with_attached_deposit(NearToken::from_yoctonear(1))
            .with_static_gas(GAS_FOR_FT_TRANSFER)
            .ft_transfer(
                receiver_id,
                U128(payment.token_amount),
                Some(format!("globalpay {} {quote_id}", payout.as_str())),
            )
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(GAS_FOR_ON_PAYOUT)
                    .on_payout(quote_id, payout),
            )
    }
}

#[cfg(test)]
mod tests;
