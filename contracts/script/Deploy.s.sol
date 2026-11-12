// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {GlobalPaySettlement} from "../src/GlobalPaySettlement.sol";

/// @notice Deploys GlobalPaySettlement using contracts/.env (TESTNET KEYS ONLY):
///   forge script script/Deploy.s.sol --rpc-url base_sepolia --broadcast --verify
/// The deployer becomes the admin; move admin to a multisig before any mainnet use.
contract Deploy is Script {
    struct Config {
        address admin;
        address treasury;
        address quoteSigner;
        address operator;
        address pauser;
        address token;
    }

    function run() external virtual returns (GlobalPaySettlement settlement) {
        uint256 deployerKey = vm.envUint("DEPLOYER_PRIVATE_KEY");
        Config memory config = Config({
            admin: vm.addr(deployerKey),
            treasury: vm.envAddress("TREASURY_ADDRESS"),
            quoteSigner: vm.envAddress("QUOTE_SIGNER_ADDRESS"),
            operator: vm.envAddress("OPERATOR_ADDRESS"),
            pauser: vm.envAddress("PAUSER_ADDRESS"),
            token: vm.envAddress("USDC_ADDRESS")
        });

        vm.startBroadcast(deployerKey);
        settlement = _deploy(config);
        vm.stopBroadcast();
    }

    /// @dev Must run while broadcasting (or pranking) as `config.admin`.
    function _deploy(Config memory config) internal returns (GlobalPaySettlement settlement) {
        settlement = new GlobalPaySettlement(config.admin, config.treasury);
        settlement.grantRole(settlement.QUOTE_SIGNER_ROLE(), config.quoteSigner);
        settlement.grantRole(settlement.OPERATOR_ROLE(), config.operator);
        settlement.grantRole(settlement.PAUSER_ROLE(), config.pauser);
        settlement.setTokenAllowed(config.token, true);

        console.log("GlobalPaySettlement:", address(settlement));
        console.log("  admin:       ", config.admin);
        console.log("  treasury:    ", config.treasury);
        console.log("  quote signer:", config.quoteSigner);
        console.log("  operator:    ", config.operator);
        console.log("  pauser:      ", config.pauser);
        console.log("  token:       ", config.token);
    }
}
