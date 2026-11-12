// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import {IERC3009} from "../../src/interfaces/IERC3009.sol";

/// @notice A broken token whose `receiveWithAuthorization` succeeds without moving funds.
///         Used to prove the settlement contract checks the amount it actually received.
contract NoopToken3009 is IERC3009 {
    function receiveWithAuthorization(
        address,
        address,
        uint256,
        uint256,
        uint256,
        bytes32,
        uint8,
        bytes32,
        bytes32
    ) external {}

    function authorizationState(address, bytes32) external pure returns (bool) {
        return false;
    }

    function balanceOf(address) external pure returns (uint256) {
        return 0;
    }
}
