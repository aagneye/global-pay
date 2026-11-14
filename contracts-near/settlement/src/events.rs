//! NEP-297 events: `EVENT_JSON:{"standard":"globalpay","version":"1.0.0","event":...,"data":[...]}`.

use near_sdk::json_types::U128;
use near_sdk::serde::Serialize;
use near_sdk::{env, serde_json, AccountId};

use crate::PaymentView;

pub const STANDARD: &str = "globalpay";
pub const VERSION: &str = "1.0.0";

#[derive(Serialize)]
#[serde(crate = "near_sdk::serde")]
struct Nep297<'a, T: Serialize> {
    standard: &'static str,
    version: &'static str,
    event: &'a str,
    data: [T; 1],
}

/// Data of `settled`, `refunded` and `payout_failed`.
#[derive(Serialize)]
#[serde(crate = "near_sdk::serde")]
pub struct PayoutData<'a> {
    pub quote_id: &'a str,
    /// "settle" or "refund".
    pub action: &'a str,
    pub token: &'a AccountId,
    /// The treasury (settle) or the payer (refund).
    pub receiver_id: &'a AccountId,
    pub token_amount: U128,
}

fn emit<T: Serialize>(event: &str, data: T) {
    let event = Nep297 { standard: STANDARD, version: VERSION, event, data: [data] };
    let json = serde_json::to_string(&event).unwrap_or_else(|_| env::abort());
    env::log_str(&format!("EVENT_JSON:{json}"));
}

pub fn payment_received(payment: &PaymentView) {
    emit("payment_received", payment);
}

pub fn settled(data: PayoutData<'_>) {
    emit("settled", data);
}

pub fn refunded(data: PayoutData<'_>) {
    emit("refunded", data);
}

/// The token transfer of a settle or refund failed; the payment is back to Paid.
pub fn payout_failed(data: PayoutData<'_>) {
    emit("payout_failed", data);
}
