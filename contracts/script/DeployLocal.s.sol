// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import {console} from "forge-std/Script.sol";
import {GlobalPaySettlement} from "../src/GlobalPaySettlement.sol";
import {MockUSDC3009} from "../test/mocks/MockUSDC3009.sol";
import {Deploy} from "./Deploy.s.sol";

/// @notice Local development deployment on anvil: mock USDC + settlement, with roles on
///         anvil's default accounts. Start `anvil`, then:
///   forge script script/DeployLocal.s.sol --rpc-url http://127.0.0.1:8545 --broadcast
///
/// Anvil accounts used (from anvil's public default mnemonic, local chain only):
///   #0 deployer, admin, pauser   #1 treasury   #2 quote signer
///   #3 operator (backend relayer)   #4 test payer, funded with 10,000 test USDC
contract DeployLocal is Deploy {
    string internal constant ANVIL_MNEMONIC =
        "test test test test test test test test test test test junk";
    uint256 internal constant ANVIL_CHAIN_ID = 31337;
    uint256 public constant TEST_PAYER_FUNDS = 10_000e6;

    /// @notice The mock USDC deployed by the last `run`.
    MockUSDC3009 public usdc;

    function run() external override returns (GlobalPaySettlement settlement) {
        require(block.chainid == ANVIL_CHAIN_ID, "DeployLocal: anvil only");
        uint256 deployerKey = vm.deriveKey(ANVIL_MNEMONIC, 0);
        address deployer = vm.addr(deployerKey);
        address payer = anvilAccount(4);

        vm.startBroadcast(deployerKey);
        usdc = new MockUSDC3009();
        settlement = _deploy(
            Config({
                admin: deployer,
                treasury: anvilAccount(1),
                quoteSigner: anvilAccount(2),
                operator: anvilAccount(3),
                pauser: deployer,
                token: address(usdc)
            })
        );
        usdc.mint(payer, TEST_PAYER_FUNDS);
        vm.stopBroadcast();

        console.log("MockUSDC3009:", address(usdc));
        console.log("Test payer (anvil #4):", payer);
    }

    function anvilAccount(uint32 index) public pure returns (address) {
        return vm.addr(vm.deriveKey(ANVIL_MNEMONIC, index));
    }
}
