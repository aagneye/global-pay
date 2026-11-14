//! "Test USDC": a NEP-141 token with NEP-145 storage management and NEP-148 metadata, built on
//! `near-contract-standards`.
//!
//! TESTNET ONLY. Its owner (and an optional minter) can mint any amount out of thin air, so it is
//! worth nothing. It stands in for USDC on NEAR testnet, where Circle's USDC is not available
//! for free. Accounts must be registered with `storage_deposit` before they can hold it.

use near_contract_standards::fungible_token::events::FtMint;
use near_contract_standards::fungible_token::metadata::{
    FungibleTokenMetadata, FungibleTokenMetadataProvider, FT_METADATA_SPEC,
};
use near_contract_standards::fungible_token::{
    FungibleToken, FungibleTokenCore, FungibleTokenResolver,
};
use near_contract_standards::storage_management::{
    StorageBalance, StorageBalanceBounds, StorageManagement,
};
use near_sdk::borsh::BorshSerialize;
use near_sdk::json_types::U128;
use near_sdk::{
    env, log, near, require, AccountId, BorshStorageKey, NearToken, PanicOnDefault, PromiseOrValue,
};

pub const NAME: &str = "Test USDC";
pub const SYMBOL: &str = "USDC";
pub const DECIMALS: u8 = 6;

#[derive(BorshSerialize, BorshStorageKey)]
#[borsh(crate = "near_sdk::borsh")]
enum StorageKey {
    FungibleToken,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct TestUsdc {
    token: FungibleToken,
    owner_id: AccountId,
    /// May mint as well as the owner (the backend's relayer, for the testnet faucet).
    minter_id: Option<AccountId>,
}

#[near]
impl TestUsdc {
    #[init]
    pub fn new(owner_id: AccountId, minter_id: Option<AccountId>) -> Self {
        Self { token: FungibleToken::new(StorageKey::FungibleToken), owner_id, minter_id }
    }

    /// Owner or minter only. `account_id` must already be registered (`storage_deposit`).
    pub fn mint(&mut self, account_id: AccountId, amount: U128) {
        let caller = env::predecessor_account_id();
        require!(
            caller == self.owner_id || self.minter_id.as_ref() == Some(&caller),
            "only the owner or the minter can mint"
        );
        require!(amount.0 > 0, "amount must be greater than zero");
        if !self.token.accounts.contains_key(&account_id) {
            env::panic_str(&format!(
                "account {account_id} is not registered: call storage_deposit first"
            ));
        }
        self.token.internal_deposit(&account_id, amount.0);
        FtMint { owner_id: &account_id, amount, memo: Some("test mint") }.emit();
    }

    /// Owner only. `None` removes the minter.
    pub fn set_minter(&mut self, minter_id: Option<AccountId>) {
        require!(env::predecessor_account_id() == self.owner_id, "only the owner can call this");
        self.minter_id = minter_id;
    }

    pub fn get_owner(&self) -> AccountId {
        self.owner_id.clone()
    }

    pub fn get_minter(&self) -> Option<AccountId> {
        self.minter_id.clone()
    }
}

#[near]
impl FungibleTokenCore for TestUsdc {
    #[payable]
    fn ft_transfer(&mut self, receiver_id: AccountId, amount: U128, memo: Option<String>) {
        self.token.ft_transfer(receiver_id, amount, memo)
    }

    #[payable]
    fn ft_transfer_call(
        &mut self,
        receiver_id: AccountId,
        amount: U128,
        memo: Option<String>,
        msg: String,
    ) -> PromiseOrValue<U128> {
        self.token.ft_transfer_call(receiver_id, amount, memo, msg)
    }

    fn ft_total_supply(&self) -> U128 {
        self.token.ft_total_supply()
    }

    fn ft_balance_of(&self, account_id: AccountId) -> U128 {
        self.token.ft_balance_of(account_id)
    }
}

#[near]
impl FungibleTokenResolver for TestUsdc {
    #[private]
    fn ft_resolve_transfer(
        &mut self,
        sender_id: AccountId,
        receiver_id: AccountId,
        amount: U128,
    ) -> U128 {
        let (used_amount, burned_amount) =
            self.token.internal_ft_resolve_transfer(&sender_id, receiver_id, amount);
        if burned_amount > 0 {
            log!("Account @{} burned {}", sender_id, burned_amount);
        }
        used_amount.into()
    }
}

#[near]
impl StorageManagement for TestUsdc {
    #[payable]
    fn storage_deposit(
        &mut self,
        account_id: Option<AccountId>,
        registration_only: Option<bool>,
    ) -> StorageBalance {
        self.token.storage_deposit(account_id, registration_only)
    }

    #[payable]
    fn storage_withdraw(&mut self, amount: Option<NearToken>) -> StorageBalance {
        self.token.storage_withdraw(amount)
    }

    #[payable]
    fn storage_unregister(&mut self, force: Option<bool>) -> bool {
        if let Some((account_id, balance)) = self.token.internal_storage_unregister(force) {
            log!("Closed @{} with {}", account_id, balance);
            true
        } else {
            false
        }
    }

    fn storage_balance_bounds(&self) -> StorageBalanceBounds {
        self.token.storage_balance_bounds()
    }

    fn storage_balance_of(&self, account_id: AccountId) -> Option<StorageBalance> {
        self.token.storage_balance_of(account_id)
    }
}

#[near]
impl FungibleTokenMetadataProvider for TestUsdc {
    fn ft_metadata(&self) -> FungibleTokenMetadata {
        FungibleTokenMetadata {
            spec: FT_METADATA_SPEC.to_owned(),
            name: NAME.to_owned(),
            symbol: SYMBOL.to_owned(),
            icon: None,
            reference: None,
            reference_hash: None,
            decimals: DECIMALS,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use near_sdk::test_utils::{get_logs, VMContextBuilder};
    use near_sdk::testing_env;

    fn account(id: &str) -> AccountId {
        id.parse().unwrap()
    }
    fn owner() -> AccountId {
        account("usdc.testnet")
    }
    fn relayer() -> AccountId {
        account("relayer.testnet")
    }
    fn alice() -> AccountId {
        account("alice.testnet")
    }

    fn call_as(predecessor: AccountId, deposit: NearToken) {
        let mut builder = VMContextBuilder::new();
        builder
            .current_account_id(owner())
            .signer_account_id(predecessor.clone())
            .predecessor_account_id(predecessor)
            .attached_deposit(deposit);
        testing_env!(builder.build());
    }

    fn setup(minter: Option<AccountId>) -> TestUsdc {
        call_as(owner(), NearToken::from_yoctonear(0));
        let mut contract = TestUsdc::new(owner(), minter);
        call_as(alice(), NearToken::from_millinear(10));
        contract.storage_deposit(None, None);
        contract
    }

    #[test]
    fn metadata_is_test_usdc_with_6_decimals() {
        let contract = setup(None);
        let metadata = contract.ft_metadata();
        assert_eq!(metadata.name, "Test USDC");
        assert_eq!(metadata.symbol, "USDC");
        assert_eq!(metadata.decimals, 6);
        assert_eq!(metadata.spec, "ft-1.0.0");
        metadata.assert_valid();
        assert_eq!(contract.get_owner(), owner());
        assert_eq!(contract.get_minter(), None);
    }

    #[test]
    fn owner_mints_to_a_registered_account() {
        let mut contract = setup(None);
        call_as(owner(), NearToken::from_yoctonear(0));
        contract.mint(alice(), U128(1_000_000_000));
        assert_eq!(contract.ft_balance_of(alice()), U128(1_000_000_000));
        assert_eq!(contract.ft_total_supply(), U128(1_000_000_000));
        let logs = get_logs();
        assert_eq!(logs.len(), 1);
        assert!(logs[0].starts_with("EVENT_JSON:"));
        assert!(logs[0].contains("\"event\":\"ft_mint\""));
        assert!(logs[0].contains("\"owner_id\":\"alice.testnet\""));
    }

    #[test]
    fn minter_can_mint() {
        let mut contract = setup(Some(relayer()));
        call_as(relayer(), NearToken::from_yoctonear(0));
        contract.mint(alice(), U128(5));
        assert_eq!(contract.ft_balance_of(alice()), U128(5));
    }

    #[test]
    #[should_panic(expected = "only the owner or the minter can mint")]
    fn mint_is_owner_only() {
        let mut contract = setup(None);
        call_as(alice(), NearToken::from_yoctonear(0));
        contract.mint(alice(), U128(5));
    }

    #[test]
    #[should_panic(expected = "only the owner or the minter can mint")]
    fn removed_minter_cannot_mint() {
        let mut contract = setup(Some(relayer()));
        call_as(owner(), NearToken::from_yoctonear(0));
        contract.set_minter(None);
        call_as(relayer(), NearToken::from_yoctonear(0));
        contract.mint(alice(), U128(5));
    }

    #[test]
    #[should_panic(expected = "only the owner can call this")]
    fn set_minter_is_owner_only() {
        let mut contract = setup(None);
        call_as(relayer(), NearToken::from_yoctonear(0));
        contract.set_minter(Some(relayer()));
    }

    #[test]
    #[should_panic(expected = "is not registered: call storage_deposit first")]
    fn mint_requires_registration() {
        let mut contract = setup(None);
        call_as(owner(), NearToken::from_yoctonear(0));
        contract.mint(account("bob.testnet"), U128(5));
    }

    #[test]
    fn minted_tokens_transfer() {
        let mut contract = setup(None);
        call_as(account("bob.testnet"), NearToken::from_millinear(10));
        contract.storage_deposit(None, None);
        call_as(owner(), NearToken::from_yoctonear(0));
        contract.mint(alice(), U128(100));
        call_as(alice(), NearToken::from_yoctonear(1));
        contract.ft_transfer(account("bob.testnet"), U128(40), None);
        assert_eq!(contract.ft_balance_of(alice()), U128(60));
        assert_eq!(contract.ft_balance_of(account("bob.testnet")), U128(40));
    }
}
