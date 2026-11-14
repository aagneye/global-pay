# fixtures

Test data shared across languages, so the Dart (mobile) and TypeScript (backend) implementations stay in step.

## `promptpay/vectors.json`

Thai PromptPay QR payloads (EMVCo format) with the expected parse result. All IDs are fake.

- `valid[]`: the payload and the fields a parser must extract.
  - `kind`: `personal` means a credit transfer (tag 29); `merchant` means a bill payment (tag 30).
  - `initiation`: `static` means a reusable QR with no amount; `dynamic` means it carries an amount.
  - `amount`: decimal string as written in the QR (`"100.00"`), or `null`.
- `invalid[]`: payloads a parser must reject, with the expected error code:
  `crc_mismatch`, `missing_crc`, `malformed_tlv`, `not_promptpay`, `unsupported_currency`, `invalid_field`.

The CRC is CRC-16/CCITT-FALSE (poly `0x1021`, init `0xFFFF`), computed over the whole payload including the `6304` tag header.

Parsers must run their checks in this order, so each invalid vector produces exactly one error:
1. A CRC tag is present (`missing_crc`) and matches (`crc_mismatch`).
2. The TLV structure is well formed (`malformed_tlv`).
3. The payload is PromptPay (`not_promptpay`), in THB (`unsupported_currency`).
4. Field values are valid (`invalid_field`):
   - the amount is a positive decimal with at most 2 fraction digits;
   - the payee ID has the right length (mobile and national ID 13 digits, e-wallet and biller 15);
   - the country is `TH`, the payload format is `01`, and initiation is `11` or `12` if present;
   - exactly one payee is named.

The file follows `promptpay/vectors.schema.json`. Consumers:
- `services/api/src/lib/promptpay/` (iteration 3)
- `apps/mobile/lib/domain/promptpay/` (iteration 5)

## `wallet/vectors.json`

Reference signatures made by viem (the backend's library) for the app wallet to match byte for byte:
- `personalSign`: a Sign-In with Ethereum message, signed with EIP-191 `personal_sign`.
- `typedData`: a USDC `ReceiveWithAuthorization` in exactly the shape `POST /quotes` returns, signed with EIP-712 (`eth_signTypedData_v4`). Includes the digest.

The key is anvil account #4, a public test key: never use it outside local chains and tests. Consumer: `apps/mobile/test/services/local_key_signer_test.dart`.

## `near/vectors.json`

NEAR rail reference bytes and signatures, made by near-api-js and the backend (`npm run near:vectors` in
`services/api`), for the app's borsh writer and signer to match byte for byte:
- `nep413`: a sign-in message as `POST /auth/nonce` writes it, its NEP-413 hash
  (`sha256(borsh(u32 2^31+413) ‖ borsh({message, nonce[32], recipient, callback_url: None}))`) and signature.
- `quote`: the quote JSON the settlement contract checks, the backend's ed25519 signature over its UTF-8
  bytes, and the `ft_transfer_call` msg. The same quote as `contracts-near/settlement/tests/fixtures/quote.json`.
- `delegate`: the NEP-366 DelegateAction for that payment (one `ft_transfer_call`, args JSON in the order
  `receiver_id, amount, msg`), its borsh encoding with the `u32 2^30+366` prefix, hash, signature and the
  base64 SignedDelegate that `POST /payments` takes as `signedDelegate`.

The keys are the public RFC 8032 Ed25519 test vectors: test only. Consumer: `services/api/test/near-vectors.test.ts`.
