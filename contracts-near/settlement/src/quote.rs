//! The signed quote carried in the `msg` of `ft_transfer_call`, and the checks on it.
//!
//! Plain functions with no host calls: the signature check is passed in, so the rules can be
//! tested on their own as well as through the contract.
//!
//! ```text
//! msg       = {"quote":"<quoteJson>","signature":"<base64 of the 64-byte ed25519 signature>"}
//! quoteJson = {"quote_id":"0x<64 hex>","payer":"<account id>","token":"<token account id>",
//!              "token_amount":"<u128>","fiat_currency":"THB","fiat_amount":"<u128 minor units>",
//!              "merchant_ref_hash":"0x<64 hex>","expires_at_ms":<u64 ms since epoch>}
//! signature = ed25519 over the exact UTF-8 bytes of quoteJson (no hashing, no prefix)
//! ```

use near_sdk::base64::engine::general_purpose::STANDARD as BASE64;
use near_sdk::base64::Engine;
use near_sdk::json_types::U128;
use near_sdk::serde::Deserialize;
use near_sdk::{bs58, serde_json, AccountId};
use std::fmt;

/// The `msg` of `ft_transfer_call`.
#[derive(Deserialize)]
#[serde(crate = "near_sdk::serde")]
struct TransferMsg {
    quote: String,
    signature: String,
}

#[derive(Deserialize)]
#[serde(crate = "near_sdk::serde")]
struct RawQuote {
    quote_id: String,
    payer: AccountId,
    token: AccountId,
    token_amount: U128,
    fiat_currency: String,
    fiat_amount: U128,
    merchant_ref_hash: String,
    expires_at_ms: u64,
}

/// A quote whose signature and fields passed every check.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Quote {
    /// `0x` + 64 lowercase hex characters.
    pub quote_id: String,
    pub payer: AccountId,
    pub token: AccountId,
    pub token_amount: u128,
    pub fiat_currency: String,
    pub fiat_amount: u128,
    /// `0x` + 64 lowercase hex characters.
    pub merchant_ref_hash: String,
    pub expires_at_ms: u64,
}

/// What `ft_on_transfer` knows about the incoming transfer.
pub struct Transfer<'a> {
    /// `sender_id` from the token: who sent the tokens.
    pub sender_id: &'a AccountId,
    /// The predecessor: the token contract that called `ft_on_transfer`.
    pub token: &'a AccountId,
    pub amount: u128,
    pub now_ms: u64,
}

#[derive(Debug, PartialEq, Eq)]
pub enum QuoteError {
    InvalidMsg(String),
    InvalidSignatureEncoding,
    InvalidSignature,
    InvalidQuote(String),
    InvalidHex32 { field: &'static str },
    InvalidCurrency,
    ZeroAmount,
    PayerMismatch { quote: AccountId, sender: AccountId },
    TokenMismatch { quote: AccountId, caller: AccountId },
    AmountMismatch { quote: u128, transferred: u128 },
    Expired { expires_at_ms: u64, now_ms: u64 },
    InvalidPublicKey,
}

impl fmt::Display for QuoteError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidMsg(e) => write!(
                f,
                "invalid msg: expected {{\"quote\":\"<quote json>\",\"signature\":\"<base64>\"}}: {e}"
            ),
            Self::InvalidSignatureEncoding => {
                write!(f, "invalid signature encoding: expected base64 of 64 bytes")
            }
            Self::InvalidSignature => write!(f, "invalid quote signature"),
            Self::InvalidQuote(e) => write!(f, "invalid quote: {e}"),
            Self::InvalidHex32 { field } => {
                write!(f, "invalid {field}: expected 0x and 64 hex characters")
            }
            Self::InvalidCurrency => {
                write!(f, "invalid fiat_currency: expected 3 uppercase letters")
            }
            Self::ZeroAmount => write!(f, "token_amount must be greater than zero"),
            Self::PayerMismatch { quote, sender } => {
                write!(f, "payer mismatch: quote is for {quote}, transfer is from {sender}")
            }
            Self::TokenMismatch { quote, caller } => {
                write!(f, "token mismatch: quote is for {quote}, transfer is from {caller}")
            }
            Self::AmountMismatch { quote, transferred } => {
                write!(f, "amount mismatch: quote is for {quote}, transfer is {transferred}")
            }
            Self::Expired { expires_at_ms, now_ms } => {
                write!(f, "quote expired: expires_at_ms {expires_at_ms}, now {now_ms}")
            }
            Self::InvalidPublicKey => {
                write!(f, "invalid public key: expected ed25519:<base58 of 32 bytes>")
            }
        }
    }
}

/// Parses `ed25519:<base58>` into the 32 key bytes.
pub fn parse_ed25519_public_key(pk: &str) -> Result<[u8; 32], QuoteError> {
    let b58 = pk.strip_prefix("ed25519:").ok_or(QuoteError::InvalidPublicKey)?;
    let bytes = bs58::decode(b58).into_vec().map_err(|_| QuoteError::InvalidPublicKey)?;
    bytes.try_into().map_err(|_| QuoteError::InvalidPublicKey)
}

/// Checks `0x` + 64 hex characters and returns it in lowercase, so one quote id has one key.
pub fn normalize_hex32(value: &str, field: &'static str) -> Result<String, QuoteError> {
    let hex = value.strip_prefix("0x").ok_or(QuoteError::InvalidHex32 { field })?;
    if hex.len() != 64 || !hex.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err(QuoteError::InvalidHex32 { field });
    }
    Ok(format!("0x{}", hex.to_ascii_lowercase()))
}

/// Runs every check on a transfer's `msg`, in this order: msg shape, quote signature, quote
/// fields, payer, token, amount, expiry. Whether the quote id was used before is up to the
/// caller, which owns the state.
///
/// `verify(signature, message, public_key)` is the ed25519 check (`env::ed25519_verify` in
/// the contract).
pub fn check_transfer(
    msg: &str,
    quote_signer_key: &[u8; 32],
    transfer: &Transfer<'_>,
    verify: impl Fn(&[u8; 64], &[u8], &[u8; 32]) -> bool,
) -> Result<Quote, QuoteError> {
    let parsed: TransferMsg =
        serde_json::from_str(msg).map_err(|e| QuoteError::InvalidMsg(e.to_string()))?;

    let signature: [u8; 64] = BASE64
        .decode(parsed.signature.as_bytes())
        .ok()
        .and_then(|bytes| bytes.try_into().ok())
        .ok_or(QuoteError::InvalidSignatureEncoding)?;
    if !verify(&signature, parsed.quote.as_bytes(), quote_signer_key) {
        return Err(QuoteError::InvalidSignature);
    }

    let raw: RawQuote =
        serde_json::from_str(&parsed.quote).map_err(|e| QuoteError::InvalidQuote(e.to_string()))?;
    let quote = Quote {
        quote_id: normalize_hex32(&raw.quote_id, "quote_id")?,
        merchant_ref_hash: normalize_hex32(&raw.merchant_ref_hash, "merchant_ref_hash")?,
        payer: raw.payer,
        token: raw.token,
        token_amount: raw.token_amount.0,
        fiat_currency: raw.fiat_currency,
        fiat_amount: raw.fiat_amount.0,
        expires_at_ms: raw.expires_at_ms,
    };
    if quote.fiat_currency.len() != 3 || !quote.fiat_currency.bytes().all(|b| b.is_ascii_uppercase())
    {
        return Err(QuoteError::InvalidCurrency);
    }
    if quote.token_amount == 0 {
        return Err(QuoteError::ZeroAmount);
    }

    if &quote.payer != transfer.sender_id {
        return Err(QuoteError::PayerMismatch {
            quote: quote.payer,
            sender: transfer.sender_id.clone(),
        });
    }
    if &quote.token != transfer.token {
        return Err(QuoteError::TokenMismatch { quote: quote.token, caller: transfer.token.clone() });
    }
    if quote.token_amount != transfer.amount {
        return Err(QuoteError::AmountMismatch {
            quote: quote.token_amount,
            transferred: transfer.amount,
        });
    }
    if transfer.now_ms >= quote.expires_at_ms {
        return Err(QuoteError::Expired { expires_at_ms: quote.expires_at_ms, now_ms: transfer.now_ms });
    }
    Ok(quote)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn account(id: &str) -> AccountId {
        id.parse().unwrap()
    }

    fn quote_json(token_amount: &str, currency: &str, quote_id: &str) -> String {
        format!(
            "{{\"quote_id\":\"{quote_id}\",\"payer\":\"payer.testnet\",\"token\":\"usdc.testnet\",\
             \"token_amount\":\"{token_amount}\",\"fiat_currency\":\"{currency}\",\"fiat_amount\":\"10000\",\
             \"merchant_ref_hash\":\"0x{}\",\"expires_at_ms\":2000}}",
            "ab".repeat(32)
        )
    }

    fn msg_for(quote: &str) -> String {
        serde_json::json!({ "quote": quote, "signature": BASE64.encode([7u8; 64]) }).to_string()
    }

    fn check(msg: &str, amount: u128, now_ms: u64) -> Result<Quote, QuoteError> {
        let (payer, token) = (account("payer.testnet"), account("usdc.testnet"));
        let transfer = Transfer { sender_id: &payer, token: &token, amount, now_ms };
        // Accept only the exact signature bytes [7; 64] for the key [1; 32].
        check_transfer(msg, &[1u8; 32], &transfer, |sig, _, pk| sig == &[7u8; 64] && pk == &[1u8; 32])
    }

    #[test]
    fn accepts_a_good_quote_and_lowercases_ids() {
        let id = format!("0x{}", "AB".repeat(32));
        let quote = check(&msg_for(&quote_json("5", "THB", &id)), 5, 1999).unwrap();
        assert_eq!(quote.quote_id, format!("0x{}", "ab".repeat(32)));
        assert_eq!(quote.token_amount, 5);
        assert_eq!(quote.fiat_amount, 10_000);
    }

    #[test]
    fn refuses_malformed_input() {
        let id = format!("0x{}", "ab".repeat(32));
        assert!(matches!(check("not json", 5, 0), Err(QuoteError::InvalidMsg(_))));
        assert!(matches!(check("{\"quote\":\"{}\"}", 5, 0), Err(QuoteError::InvalidMsg(_))));
        let bad_sig = serde_json::json!({ "quote": "{}", "signature": "AAAA" }).to_string();
        assert_eq!(check(&bad_sig, 5, 0), Err(QuoteError::InvalidSignatureEncoding));
        assert!(matches!(check(&msg_for("{}"), 5, 0), Err(QuoteError::InvalidQuote(_))));
        assert!(matches!(
            check(&msg_for(&quote_json("5", "THB", "0x1234")), 5, 0),
            Err(QuoteError::InvalidHex32 { field: "quote_id" })
        ));
        assert_eq!(check(&msg_for(&quote_json("5", "thb", &id)), 5, 0), Err(QuoteError::InvalidCurrency));
        assert_eq!(check(&msg_for(&quote_json("0", "THB", &id)), 0, 0), Err(QuoteError::ZeroAmount));
        // Amounts are decimal strings, not JSON numbers.
        let numeric = quote_json("5", "THB", &id).replace("\"5\"", "5");
        assert!(matches!(check(&msg_for(&numeric), 5, 0), Err(QuoteError::InvalidQuote(_))));
    }

    #[test]
    fn refuses_amount_mismatch_and_expiry() {
        let id = format!("0x{}", "ab".repeat(32));
        let msg = msg_for(&quote_json("5", "THB", &id));
        assert_eq!(check(&msg, 6, 0), Err(QuoteError::AmountMismatch { quote: 5, transferred: 6 }));
        assert_eq!(check(&msg, 5, 2000), Err(QuoteError::Expired { expires_at_ms: 2000, now_ms: 2000 }));
    }

    #[test]
    fn parses_ed25519_public_keys() {
        let key = parse_ed25519_public_key("ed25519:FVen3X669xLzsi6N2V91DoiyzHzg1uAgqiT8jZ9nS96Z").unwrap();
        assert_eq!(key[0], 0xd7);
        assert_eq!(key[31], 0x1a);
        assert_eq!(parse_ed25519_public_key("FVen3X669xLzsi6N2V91DoiyzHzg1uAgqiT8jZ9nS96Z"), Err(QuoteError::InvalidPublicKey));
        assert_eq!(parse_ed25519_public_key("ed25519:abc"), Err(QuoteError::InvalidPublicKey));
        assert_eq!(parse_ed25519_public_key("ed25519:0OIl"), Err(QuoteError::InvalidPublicKey));
    }
}
