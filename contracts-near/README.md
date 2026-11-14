# contracts-near

GlobalPay's contracts on NEAR (testnet). Rust, near-sdk 5.27, Rust 1.86.0.

| Contract | Crate | Wasm | What it does |
| --- | --- | --- | --- |
| Settlement | `settlement/` | `res/settlement.wasm` | Receives a USDC payment with a signed quote, holds it, then settles it to the treasury or refunds the payer. The NEAR twin of `contracts/src/GlobalPaySettlement.sol`. |
| Test USDC | `test-usdc/` | `res/test_usdc.wasm` | **Testnet only.** A NEP-141 token ("Test USDC", symbol USDC, 6 decimals) with NEP-145 storage and an owner/minter `mint`. Worth nothing. |

The release wasm files are committed in `res/` so you can deploy without installing Rust.
They are deployed by the backend: `cd services/api && npm run near:testnet -- init|deploy|status|mint`.

## How a payment works

1. The payer calls `ft_transfer_call` on the token (1 yoctoNEAR attached):
   `{"receiver_id": "<settlement>", "amount": "<token_amount>", "msg": "<msg>"}`.
2. The token calls the settlement's `ft_on_transfer(sender_id, amount, msg)`. It checks, in order:
   the caller is the configured token, the msg shape, the quote signature, the quote fields,
   `payer == sender_id`, `token == caller`, `token_amount == amount`,
   `block_timestamp_ms < expires_at_ms`, and that the quote id was never used.
   Any failure panics with a clear message and the token refunds the payer.
3. On success the payment is stored as `Paid`, appended to the paid log, a `payment_received`
   event is logged and the contract keeps all the tokens (returns `"0"`).
4. The operator calls `settle(quote_id)` (tokens to the treasury) or `refund(quote_id)` (back to
   the payer) with at least 40 TGas. The status changes first, then `ft_transfer` runs (1 yocto
   from the contract's balance); its callback `on_payout` rolls the status back to `Paid` if the
   transfer failed. The call's final value is `true` if the tokens moved, `false` if rolled back.

### The `msg` format

```text
msg       = JSON.stringify({ quote: quoteJson, signature: base64(ed25519(utf8(quoteJson))) })
quoteJson = JSON.stringify({
  quote_id: "0x<64 hex>",            // any case; stored lowercase
  payer: "<account id>",             // the implicit account (64 hex) of the payer
  token: "<token account id>",
  token_amount: "<u128 decimal>",    // a string, in token units (6 decimals)
  fiat_currency: "THB",              // 3 uppercase letters
  fiat_amount: "<u128 decimal>",     // a string, in minor units (satang)
  merchant_ref_hash: "0x<64 hex>",
  expires_at_ms: 1800000060000       // a number, ms since the epoch
})
```

`msg.quote` is the quote JSON **as a string**: the signature covers its exact UTF-8 bytes, so
key order and spacing are free but must not change after signing. The signature is raw
ed25519 (no hashing, no prefix) by the key set as `quote_signer_pk` (`ed25519:<base58>`).
Extra fields in the quote are ignored. A worked example with the signature is in
`settlement/tests/fixtures/quote.json`, made by `node settlement/tests/fixtures/make_quote.mjs`
(its keys are the public RFC 8032 test vectors: **test only**).

### Settlement methods

| Method | Who | Notes |
| --- | --- | --- |
| `new(owner, operator, treasury, token, quote_signer_pk)` | init | `quote_signer_pk` is `ed25519:<base58 of 32 bytes>` |
| `ft_on_transfer(sender_id, amount, msg)` | the token | see above |
| `settle(quote_id)`, `refund(quote_id)` | operator | Paid only; attach >= 40 TGas |
| `set_operator(account)`, `set_quote_signer(pk)` | owner | |
| `get_payment(quote_id) -> PaymentView \| null` | view | |
| `paid_count() -> u64` | view | number of payments ever received |
| `get_paid_events(from_index, limit) -> PaymentView[]` | view | paid order; the backend's indexer cursor; keep `limit` <= 100 |
| `get_config() -> {owner, operator, treasury, token, quote_signer_pk}` | view | |

`PaymentView` is `{quote_id, payer, token, token_amount, fiat_currency, fiat_amount,
merchant_ref_hash, status, paid_block, index}`, with amounts as decimal strings, `status` one of
`"Paid" | "Settled" | "Refunded"` (the current status), and `paid_block`/`index` as numbers.

Events are NEP-297 logs: `EVENT_JSON:{"standard":"globalpay","version":"1.0.0","event":...,"data":[...]}`.

| Event | When | `data[0]` |
| --- | --- | --- |
| `payment_received` | a payment is recorded | the `PaymentView` |
| `settled` / `refunded` | the payout transfer succeeded (logged by `on_payout`) | `{quote_id, action: "settle"\|"refund", token, receiver_id, token_amount}` |
| `payout_failed` | the payout transfer failed; status is back to Paid | same as above |

Storage for payments (about 0.005 NEAR each) is paid from the settlement account's own balance.
The treasury and the settlement account must be registered on the token (`storage_deposit`).

### Test USDC methods

NEP-141 (`ft_transfer`, `ft_transfer_call`, `ft_balance_of`, `ft_total_supply`), NEP-145
(`storage_deposit`, ...), NEP-148 (`ft_metadata`), plus:
`new(owner_id, minter_id?)`, `mint(account_id, amount)` (owner or minter; the account must be
registered with `storage_deposit` first), `set_minter(minter_id?)` (owner), `get_owner`, `get_minter`.

## Build

```bash
cd contracts-near
./build.sh                                      # -> res/settlement.wasm, res/test_usdc.wasm
node scripts/check-wasm.mjs res/*.wasm          # checks the wasm uses only what NEAR accepts
```

`build.sh` runs `cargo build --target wasm32-unknown-unknown --release` and copies the files.
The committed wasm was built with:

- Rust **1.86.0** (`rust-toolchain.toml`; 1.87+ emits bulk-memory ops NEAR rejects), host
  `x86_64-pc-windows-gnu`, target `wasm32-unknown-unknown`;
- release profile: `opt-level = "z"`, `lto = true`, `codegen-units = 1`, `panic = "abort"`,
  `overflow-checks = true`, `debug = false`;
- rustflags from `.cargo/config.toml`: `-C target-cpu=mvp -C link-arg=-s
  -C link-arg=--compress-relocations`. Without `--compress-relocations`, std (prebuilt with
  reference types) leaves padded `call_indirect` table indices that NEAR's wasm parser refuses.
  The result is WebAssembly MVP plus sign-extension ops.

The committed files (settlement.wasm 213,829 bytes, test_usdc.wasm 186,493 bytes) also pass
nearcore's own `prepare_contract` (near-vm-runner 0.35.1, protocol versions 80, 83 and 84,
NearVM and Wasmtime). Deploying locks about 2.2 NEAR (settlement) and 1.9 NEAR (token) of
storage for the code.

## Test

```bash
cd contracts-near
cargo test
```

Unit tests run on near-sdk's mocked blockchain with real ed25519 signatures (signed in the
tests with `ed25519-dalek`, verified by the mocked `ed25519_verify` host function).

## Windows notes

Rust is installed with the GNU host (`rustup-init --default-host x86_64-pc-windows-gnu`), no
MSVC needed. An older SJLJ MinGW gcc on PATH cannot link Rust's std, so `.cargo/config.toml`
passes `-C link-self-contained=yes` for host builds (tests) and `build.sh` hides the system gcc
from PATH for the wasm build (build scripts then link with the MinGW bundled with Rust).
