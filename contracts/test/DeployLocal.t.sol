// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {GlobalPaySettlement} from "../src/GlobalPaySettlement.sol";
import {DeployLocal} from "../script/DeployLocal.s.sol";

/// @notice Runs the local deploy script in-process and checks the wiring it produces.
contract DeployLocalTest is Test {
    DeployLocal internal script;
    GlobalPaySettlement internal settlement;

    function setUp() public {
        vm.chainId(31337);
        script = new DeployLocal();
        settlement = script.run();
    }

    function test_grantsRolesToAnvilAccounts() public view {
        address deployer = script.anvilAccount(0);
        assertTrue(settlement.hasRole(settlement.DEFAULT_ADMIN_ROLE(), deployer));
        assertTrue(settlement.hasRole(settlement.PAUSER_ROLE(), deployer));
        assertEq(settlement.treasury(), script.anvilAccount(1));
        assertTrue(settlement.hasRole(settlement.QUOTE_SIGNER_ROLE(), script.anvilAccount(2)));
        assertTrue(settlement.hasRole(settlement.OPERATOR_ROLE(), script.anvilAccount(3)));
    }

    function test_allowlistsAndFundsMockUsdc() public view {
        address usdc = address(script.usdc());
        assertTrue(settlement.isTokenAllowed(usdc));
        assertEq(script.usdc().balanceOf(script.anvilAccount(4)), script.TEST_PAYER_FUNDS());
    }

    function test_refusesNonAnvilChains() public {
        vm.chainId(84532);
        DeployLocal other = new DeployLocal();
        vm.expectRevert(bytes("DeployLocal: anvil only"));
        other.run();
    }
}
