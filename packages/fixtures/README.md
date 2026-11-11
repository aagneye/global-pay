# fixtures

Test data shared across languages, so the Dart (mobile) and TypeScript (backend) implementations stay in step.

## `promptpay/vectors.json`

Thai PromptPay QR payloads (EMVCo format) with the expected parse result. All IDs are fake.

- `valid[]`: the payload and the fields a parser must extract.
  - `kind`: `personal` means a credit transfer (tag 29); `merchant` means a bill payment (tag 30).
  - `initiation`: `static` means a reusable QR with no amount; `dynamic` means it carries an amount.
  - `amount`: decimal string as written in the QR (`"100.00"`), or `null`.
- `invalid[]`: payloads a parser must reject, with the expected error code:
  `crc_mismatch`, `missing_crc`, `malformed_tlv`, `not_promptpay`, `unsupported_currency`.

The CRC is CRC-16/CCITT-FALSE (poly `0x1021`, init `0xFFFF`), computed over the whole payload including the `6304` tag header.

Parsers must run their checks in this order, so each invalid vector produces exactly one error:
1. A CRC tag is present (`missing_crc`) and matches (`crc_mismatch`).
2. The TLV structure is well formed (`malformed_tlv`).
3. The payload is PromptPay (`not_promptpay`), in THB (`unsupported_currency`).

The file follows `promptpay/vectors.schema.json`. Consumers:
- `services/api/src/lib/promptpay/` (iteration 3)
- `apps/mobile/lib/domain/promptpay/` (iteration 5)
