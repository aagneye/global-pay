# contracts

Solidity contracts for GlobalPay, built with [Foundry](https://book.getfoundry.sh/). Target network: **Base** (Base Sepolia for development).

## Layout

```
src/
  interfaces/
    IGlobalPaySettlement.sol   settlement contract interface: quote, payment states, events, errors
    IERC3009.sol               USDC transfer-with-authorization (gasless payments)
  GlobalPaySettlement.sol      implementation (iteration 2)
test/
  GlobalPaySettlement.t.sol    unit + fuzz tests (iteration 2)
  mocks/MockUSDC3009.sol       ERC-20 with EIP-3009, for tests and anvil (iteration 2)
script/
  Deploy.s.sol                 deploy, grant roles, allowlist USDC (iteration 2)
```

## How it works

1. The backend signs an EIP-712 `Quote`.
2. The user's wallet signs a USDC `ReceiveWithAuthorization` with `nonce = quoteId`.
3. The relayer calls `pay()`. The contract pulls the USDC and emits `PaymentReceived`.
4. After the off-chain baht payout, the operator calls either:
   - `markSettled()`, which sends the USDC to the treasury; or
   - `refund()`, which sends the USDC back to the payer.

Full details are in [`docs/architecture.md`](../docs/architecture.md). The design choices are explained in [ADR 0002](../docs/adr/0002-usdc-eip3009-gasless.md).

## Commands (from iteration 2)

```bash
forge install foundry-rs/forge-std OpenZeppelin/openzeppelin-contracts
forge build
forge test -vvv
forge script script/Deploy.s.sol --rpc-url base_sepolia --broadcast --verify
```

Copy `.env.example` to `.env` first. Use testnet keys only.
