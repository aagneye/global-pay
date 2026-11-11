// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

/// @title IERC3009
/// @notice The part of EIP-3009 (Transfer With Authorization) that GlobalPay uses.
///         Circle's USDC implements it on Base and Base Sepolia.
/// @dev `receiveWithAuthorization` requires `msg.sender == to`, so only the
///      recipient (the settlement contract) can execute a signed authorisation.
///      This stops anyone from front-running a payment.
interface IERC3009 {
    /// @notice Pull `value` tokens from `from` to `to` (the caller) using `from`'s signature.
    function receiveWithAuthorization(
        address from,
        address to,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external;

    /// @notice True if `nonce` has already been used or cancelled for `authorizer`.
    function authorizationState(address authorizer, bytes32 nonce) external view returns (bool);
}
