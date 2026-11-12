# contracts

Solidity contracts for GlobalPay, built with [Foundry](https://getfoundry.sh/). Target network: **Base** (Base Sepolia for development).

**Status:** iteration 2 is complete.
- `GlobalPaySettlement` is implemented and tested: 42 tests including fuzzing, with 100% line and branch coverage.
- Deploy scripts are tested on a local chain (anvil).
- Nothing is deployed to Base Sepolia yet; that happens in iteration 6.

## Layout

```
src/
  GlobalPaySettlement.sol      settlement contract
  interfaces/
    IGlobalPaySettlement.sol   quote, payment states, events, errors
    IERC3009.sol               USDC transfer-with-authorization (gasless payments)
test/
  GlobalPaySettlement.t.sol    unit + fuzz tests
  DeployLocal.t.sol            checks the local deploy script's wiring
  mocks/
    MockUSDC3009.sol           USDC stand-in (6 decimals, EIP-3009, domain "USDC" v"2")
    MockUSDC3009.t.sol         tests for the mock itself
    NoopToken3009.sol          broken token, used to test the received-amount check
script/
  Deploy.s.sol                 deploy from .env (Base Sepolia, iteration 6)
  DeployLocal.s.sol            deploy mock USDC + settlement to anvil
lib/                           forge-std v1.17.0, OpenZeppelin v5.7.0 (git submodules)
```

## How it works

1. The backend signs an EIP-712 `Quote`.
2. The user's wallet signs a USDC `ReceiveWithAuthorization` with `nonce = quoteId` and `validBefore = expiresAt`.
3. Anyone can submit `pay()`. Normally the backend relayer does it and pays the gas. The contract:
   - checks the quote;
   - records the payment as `Paid`;
   - pulls the USDC;
   - checks it received exactly the quoted amount.
4. After the off-chain baht payout, the operator calls either:
   - `markSettled()`, which sends the USDC to the treasury; or
   - `refund()`, which sends the USDC back to the payer.

| Role | Can |
|---|---|
| `DEFAULT_ADMIN_ROLE` | Grant and revoke roles, set treasury, allowlist tokens, **unpause** |
| `QUOTE_SIGNER_ROLE` | Sign quotes that `pay` accepts |
| `OPERATOR_ROLE` | `markSettled`, `refund` |
| `PAUSER_ROLE` | `pause` (blocks new payments only; settle and refund keep working) |

A quote is valid while `block.timestamp < expiresAt`, the same rule USDC uses for `validBefore`. Full details are in [`docs/architecture.md`](../docs/architecture.md). The design decisions are in [ADR 0002](../docs/adr/0002-usdc-eip3009-gasless.md) and [ADR 0006](../docs/adr/0006-immutable-settlement-contract.md).

## Commands

After cloning, fetch the libraries:

```bash
git submodule update --init --recursive
```

```bash
forge build
forge test
forge coverage --report summary --no-match-coverage "(test|script)/"
forge fmt --check
forge lint
```

On Windows, if `forge --version` doesn't print Foundry, another `forge` is shadowing it. See [docs/setup.md](../docs/setup.md).

## Local chain (anvil)

Start `anvil` in one terminal, then in another:

```bash
forge script script/DeployLocal.s.sol --rpc-url http://127.0.0.1:8545 --broadcast
```

On a fresh anvil this deploys to fixed addresses: `MockUSDC3009` at `0x5FbDB2315678afecb367f032d93F642f64180aa3` and `GlobalPaySettlement` at `0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512`.

Roles use anvil's default test accounts. Their keys are public, so use them on the local chain only.

| Anvil account | Used as |
|---|---|
| #0 | Deployer, admin, pauser |
| #1 | Treasury |
| #2 | Quote signer (backend `QUOTE_SIGNER_PRIVATE_KEY`) |
| #3 | Operator (backend `RELAYER_PRIVATE_KEY`) |
| #4 | Test payer, funded with 10,000 test USDC |

## Base Sepolia (iteration 6)

Copy `.env.example` to `.env` and fill it in with **testnet keys only**. Then:

```bash
forge script script/Deploy.s.sol --rpc-url base_sepolia --broadcast --verify
```
