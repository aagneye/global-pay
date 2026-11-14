// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {MockUSDC3009} from "./MockUSDC3009.sol";

/// @notice The settlement tests rely on this mock behaving like USDC, so it is tested too.
contract MockUSDC3009Test is Test {
    MockUSDC3009 internal token;

    uint256 internal constant PAYER_PK = 0xA11CE;
    address internal payer;
    address internal payee = makeAddr("payee");

    uint256 internal constant START = 1_800_000_000;
    uint256 internal constant VALUE = 25e6;
    bytes32 internal constant NONCE = keccak256("nonce-1");

    function setUp() public {
        vm.warp(START);
        token = new MockUSDC3009();
        payer = vm.addr(PAYER_PK);
        token.mint(payer, 100e6);
    }

    /// @dev Signs an authorization that claims to be from `payer`, using key `pk`.
    function _sign(uint256 pk, address to, uint256 validAfter, uint256 validBefore, bytes32 nonce)
        internal
        view
        returns (uint8 v, bytes32 r, bytes32 s)
    {
        bytes32 structHash = keccak256(
            abi.encode(
                token.RECEIVE_WITH_AUTHORIZATION_TYPEHASH(),
                payer,
                to,
                VALUE,
                validAfter,
                validBefore,
                nonce
            )
        );
        bytes32 digest =
            keccak256(abi.encodePacked("\x19\x01", token.DOMAIN_SEPARATOR(), structHash));
        (v, r, s) = vm.sign(pk, digest);
    }

    function _receive(
        address from,
        uint256 validAfter,
        uint256 validBefore,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) internal {
        token.receiveWithAuthorization(from, payee, VALUE, validAfter, validBefore, NONCE, v, r, s);
    }

    function test_metadataMatchesUsdc() public view {
        assertEq(token.name(), "USDC");
        assertEq(token.version(), "2");
        assertEq(token.decimals(), 6);
    }

    function test_receiveWithAuthorization_transfersAndUsesNonce() public {
        (uint8 v, bytes32 r, bytes32 s) = _sign(PAYER_PK, payee, 0, START + 60, NONCE);

        vm.expectEmit(address(token));
        emit MockUSDC3009.AuthorizationUsed(payer, NONCE);
        vm.prank(payee);
        _receive(payer, 0, START + 60, v, r, s);

        assertEq(token.balanceOf(payee), VALUE);
        assertEq(token.balanceOf(payer), 100e6 - VALUE);
        assertTrue(token.authorizationState(payer, NONCE));
    }

    function test_revert_callerIsNotPayee() public {
        (uint8 v, bytes32 r, bytes32 s) = _sign(PAYER_PK, payee, 0, START + 60, NONCE);
        address stranger = makeAddr("stranger");

        vm.prank(stranger);
        vm.expectRevert(
            abi.encodeWithSelector(MockUSDC3009.CallerMustBePayee.selector, stranger, payee)
        );
        _receive(payer, 0, START + 60, v, r, s);
    }

    function test_revert_notYetValid() public {
        (uint8 v, bytes32 r, bytes32 s) = _sign(PAYER_PK, payee, START, START + 60, NONCE);

        vm.prank(payee);
        vm.expectRevert(
            abi.encodeWithSelector(MockUSDC3009.AuthorizationNotYetValid.selector, START)
        );
        _receive(payer, START, START + 60, v, r, s);
    }

    function test_revert_expiredAtValidBefore() public {
        (uint8 v, bytes32 r, bytes32 s) = _sign(PAYER_PK, payee, 0, START + 60, NONCE);
        vm.warp(START + 60);

        vm.prank(payee);
        vm.expectRevert(
            abi.encodeWithSelector(MockUSDC3009.AuthorizationExpired.selector, START + 60)
        );
        _receive(payer, 0, START + 60, v, r, s);
    }

    function test_revert_nonceReused() public {
        (uint8 v, bytes32 r, bytes32 s) = _sign(PAYER_PK, payee, 0, START + 60, NONCE);
        vm.startPrank(payee);
        _receive(payer, 0, START + 60, v, r, s);

        vm.expectRevert(
            abi.encodeWithSelector(MockUSDC3009.AuthorizationAlreadyUsed.selector, payer, NONCE)
        );
        _receive(payer, 0, START + 60, v, r, s);
        vm.stopPrank();
    }

    function test_revert_signedByAnotherWallet() public {
        uint256 otherPk = 0xB0B;
        (uint8 v, bytes32 r, bytes32 s) = _sign(otherPk, payee, 0, START + 60, NONCE);

        vm.prank(payee);
        vm.expectRevert(
            abi.encodeWithSelector(
                MockUSDC3009.InvalidAuthorizationSignature.selector, vm.addr(otherPk), payer
            )
        );
        _receive(payer, 0, START + 60, v, r, s);
    }

    /// @dev Signs a TransferWithAuthorization from `payer` to `payee`.
    function _signTransfer(uint256 pk, uint256 validBefore, bytes32 nonce)
        internal
        view
        returns (uint8 v, bytes32 r, bytes32 s)
    {
        bytes32 structHash = keccak256(
            abi.encode(
                token.TRANSFER_WITH_AUTHORIZATION_TYPEHASH(),
                payer,
                payee,
                VALUE,
                0,
                validBefore,
                nonce
            )
        );
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", token.DOMAIN_SEPARATOR(), structHash));
        (v, r, s) = vm.sign(pk, digest);
    }

    function test_transferWithAuthorization_anyoneCanSubmit() public {
        (uint8 v, bytes32 r, bytes32 s) = _signTransfer(PAYER_PK, START + 60, NONCE);
        vm.expectEmit(address(token));
        emit MockUSDC3009.AuthorizationUsed(payer, NONCE);
        vm.prank(makeAddr("relayer"));
        token.transferWithAuthorization(payer, payee, VALUE, 0, START + 60, NONCE, v, r, s);
        assertEq(token.balanceOf(payee), VALUE);
        assertTrue(token.authorizationState(payer, NONCE));
    }

    function test_transferWithAuthorization_sharesNoncesWithReceive() public {
        (uint8 v, bytes32 r, bytes32 s) = _signTransfer(PAYER_PK, START + 60, NONCE);
        token.transferWithAuthorization(payer, payee, VALUE, 0, START + 60, NONCE, v, r, s);

        (v, r, s) = _sign(PAYER_PK, payee, 0, START + 60, NONCE);
        vm.prank(payee);
        vm.expectRevert(
            abi.encodeWithSelector(MockUSDC3009.AuthorizationAlreadyUsed.selector, payer, NONCE)
        );
        _receive(payer, 0, START + 60, v, r, s);
    }

    function test_revert_transfer_expired() public {
        (uint8 v, bytes32 r, bytes32 s) = _signTransfer(PAYER_PK, START, NONCE);
        vm.expectRevert(abi.encodeWithSelector(MockUSDC3009.AuthorizationExpired.selector, START));
        token.transferWithAuthorization(payer, payee, VALUE, 0, START, NONCE, v, r, s);
    }

    function test_revert_receiveSignatureCannotTransfer() public {
        // Signed as ReceiveWithAuthorization: the typehash differs, so it recovers someone else.
        (uint8 v, bytes32 r, bytes32 s) = _sign(PAYER_PK, payee, 0, START + 60, NONCE);
        vm.expectPartialRevert(MockUSDC3009.InvalidAuthorizationSignature.selector);
        token.transferWithAuthorization(payer, payee, VALUE, 0, START + 60, NONCE, v, r, s);
    }

    function test_revert_transfer_changedAmount() public {
        (uint8 v, bytes32 r, bytes32 s) = _signTransfer(PAYER_PK, START + 60, NONCE);
        vm.expectPartialRevert(MockUSDC3009.InvalidAuthorizationSignature.selector);
        token.transferWithAuthorization(payer, payee, VALUE + 1, 0, START + 60, NONCE, v, r, s);
    }
}
