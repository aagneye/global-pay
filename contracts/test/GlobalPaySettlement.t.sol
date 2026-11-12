// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {GlobalPaySettlement} from "../src/GlobalPaySettlement.sol";
import {IGlobalPaySettlement} from "../src/interfaces/IGlobalPaySettlement.sol";
import {MockUSDC3009} from "./mocks/MockUSDC3009.sol";
import {NoopToken3009} from "./mocks/NoopToken3009.sol";

contract GlobalPaySettlementTest is Test {
    GlobalPaySettlement internal settlement;
    MockUSDC3009 internal usdc;

    address internal admin = makeAddr("admin");
    address internal treasury = makeAddr("treasury");
    address internal operator = makeAddr("operator");
    address internal pauser = makeAddr("pauser");
    address internal relayer = makeAddr("relayer");
    address internal stranger = makeAddr("stranger");

    uint256 internal constant QUOTE_SIGNER_PK = 0x5167;
    uint256 internal constant PAYER_PK = 0xA11CE;
    uint256 internal constant OTHER_PK = 0xB0B;
    address internal quoteSigner;
    address internal payer;

    uint256 internal constant START = 1_800_000_000;
    uint256 internal constant AMOUNT = 2_850_000; // 2.85 USDC for a 100 THB payment
    uint256 internal constant PAYER_FUNDS = 1_000e6;
    uint256 internal constant FIAT_AMOUNT = 10_000; // 100.00 THB in satang
    bytes32 internal constant QUOTE_ID = keccak256("quote-1");
    bytes32 internal constant QUOTE_ID_2 = keccak256("quote-2");
    bytes32 internal constant MERCHANT_REF_HASH = keccak256("biller:099999999999901");

    function setUp() public {
        vm.warp(START);
        quoteSigner = vm.addr(QUOTE_SIGNER_PK);
        payer = vm.addr(PAYER_PK);

        usdc = new MockUSDC3009();
        settlement = new GlobalPaySettlement(admin, treasury);

        bytes32 signerRole = settlement.QUOTE_SIGNER_ROLE();
        bytes32 operatorRole = settlement.OPERATOR_ROLE();
        bytes32 pauserRole = settlement.PAUSER_ROLE();
        vm.startPrank(admin);
        settlement.grantRole(signerRole, quoteSigner);
        settlement.grantRole(operatorRole, operator);
        settlement.grantRole(pauserRole, pauser);
        settlement.setTokenAllowed(address(usdc), true);
        vm.stopPrank();

        usdc.mint(payer, PAYER_FUNDS);
    }

    // ------------------------------------------------------------------ helpers

    function _quote(bytes32 quoteId, uint256 amount)
        internal
        view
        returns (IGlobalPaySettlement.Quote memory)
    {
        return IGlobalPaySettlement.Quote({
            quoteId: quoteId,
            payer: payer,
            token: address(usdc),
            tokenAmount: amount,
            fiatCurrency: bytes3("THB"),
            fiatAmount: FIAT_AMOUNT,
            merchantRefHash: MERCHANT_REF_HASH,
            expiresAt: uint64(block.timestamp + 60)
        });
    }

    function _signQuote(uint256 pk, IGlobalPaySettlement.Quote memory quote)
        internal
        view
        returns (bytes memory)
    {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, settlement.hashQuote(quote));
        return abi.encodePacked(r, s, v);
    }

    /// @dev The user's USDC ReceiveWithAuthorization for `quote`, signed with key `pk`.
    function _authorize(uint256 pk, IGlobalPaySettlement.Quote memory quote)
        internal
        view
        returns (IGlobalPaySettlement.Authorization memory auth)
    {
        auth.validAfter = 0;
        auth.validBefore = quote.expiresAt;
        bytes32 structHash = keccak256(
            abi.encode(
                usdc.RECEIVE_WITH_AUTHORIZATION_TYPEHASH(),
                quote.payer,
                address(settlement),
                quote.tokenAmount,
                auth.validAfter,
                auth.validBefore,
                quote.quoteId
            )
        );
        bytes32 digest =
            keccak256(abi.encodePacked("\x19\x01", usdc.DOMAIN_SEPARATOR(), structHash));
        (auth.v, auth.r, auth.s) = vm.sign(pk, digest);
    }

    function _signed(IGlobalPaySettlement.Quote memory quote)
        internal
        view
        returns (bytes memory quoteSig, IGlobalPaySettlement.Authorization memory auth)
    {
        quoteSig = _signQuote(QUOTE_SIGNER_PK, quote);
        auth = _authorize(PAYER_PK, quote);
    }

    function _pay(IGlobalPaySettlement.Quote memory quote) internal {
        (bytes memory quoteSig, IGlobalPaySettlement.Authorization memory auth) = _signed(quote);
        vm.prank(relayer);
        settlement.pay(quote, quoteSig, auth);
    }

    function _status(bytes32 quoteId) internal view returns (IGlobalPaySettlement.PaymentStatus) {
        return settlement.paymentOf(quoteId).status;
    }

    function _unauthorized(address account, bytes32 role) internal pure returns (bytes memory) {
        return abi.encodeWithSelector(
            IAccessControl.AccessControlUnauthorizedAccount.selector, account, role
        );
    }

    function _invalidStatus(bytes32 quoteId, IGlobalPaySettlement.PaymentStatus status)
        internal
        pure
        returns (bytes memory)
    {
        return abi.encodeWithSelector(
            IGlobalPaySettlement.InvalidPaymentStatus.selector, quoteId, status
        );
    }

    // -------------------------------------------------------------- happy paths

    function test_constructor_setsAdminAndTreasury() public view {
        assertTrue(settlement.hasRole(settlement.DEFAULT_ADMIN_ROLE(), admin));
        assertEq(settlement.treasury(), treasury);
        assertTrue(settlement.isTokenAllowed(address(usdc)));
    }

    function test_pay_pullsUsdcAndRecordsPayment() public {
        IGlobalPaySettlement.Quote memory quote = _quote(QUOTE_ID, AMOUNT);
        (bytes memory quoteSig, IGlobalPaySettlement.Authorization memory auth) = _signed(quote);

        vm.expectEmit(address(settlement));
        emit IGlobalPaySettlement.PaymentReceived(
            QUOTE_ID, payer, address(usdc), AMOUNT, bytes3("THB"), FIAT_AMOUNT, MERCHANT_REF_HASH
        );
        vm.prank(relayer);
        settlement.pay(quote, quoteSig, auth);

        assertEq(usdc.balanceOf(payer), PAYER_FUNDS - AMOUNT);
        assertEq(usdc.balanceOf(address(settlement)), AMOUNT);
        assertTrue(usdc.authorizationState(payer, QUOTE_ID));

        IGlobalPaySettlement.Payment memory payment = settlement.paymentOf(QUOTE_ID);
        assertEq(payment.payer, payer);
        assertEq(payment.token, address(usdc));
        assertEq(payment.tokenAmount, AMOUNT);
        assertEq(uint8(payment.status), uint8(IGlobalPaySettlement.PaymentStatus.Paid));
    }

    function test_pay_canBeRelayedByAnyone() public {
        IGlobalPaySettlement.Quote memory quote = _quote(QUOTE_ID, AMOUNT);
        (bytes memory quoteSig, IGlobalPaySettlement.Authorization memory auth) = _signed(quote);

        vm.prank(stranger);
        settlement.pay(quote, quoteSig, auth);

        assertEq(uint8(_status(QUOTE_ID)), uint8(IGlobalPaySettlement.PaymentStatus.Paid));
    }

    function test_pay_succeedsOneSecondBeforeExpiry() public {
        IGlobalPaySettlement.Quote memory quote = _quote(QUOTE_ID, AMOUNT);
        (bytes memory quoteSig, IGlobalPaySettlement.Authorization memory auth) = _signed(quote);

        vm.warp(quote.expiresAt - 1);
        settlement.pay(quote, quoteSig, auth);

        assertEq(uint8(_status(QUOTE_ID)), uint8(IGlobalPaySettlement.PaymentStatus.Paid));
    }

    function test_markSettled_sendsUsdcToTreasury() public {
        _pay(_quote(QUOTE_ID, AMOUNT));

        vm.expectEmit(address(settlement));
        emit IGlobalPaySettlement.PaymentSettled(QUOTE_ID, treasury, AMOUNT);
        vm.prank(operator);
        settlement.markSettled(QUOTE_ID);

        assertEq(usdc.balanceOf(treasury), AMOUNT);
        assertEq(usdc.balanceOf(address(settlement)), 0);
        assertEq(uint8(_status(QUOTE_ID)), uint8(IGlobalPaySettlement.PaymentStatus.Settled));
    }

    function test_refund_returnsUsdcToPayer() public {
        _pay(_quote(QUOTE_ID, AMOUNT));

        vm.expectEmit(address(settlement));
        emit IGlobalPaySettlement.PaymentRefunded(QUOTE_ID, payer, AMOUNT);
        vm.prank(operator);
        settlement.refund(QUOTE_ID);

        assertEq(usdc.balanceOf(payer), PAYER_FUNDS);
        assertEq(usdc.balanceOf(address(settlement)), 0);
        assertEq(uint8(_status(QUOTE_ID)), uint8(IGlobalPaySettlement.PaymentStatus.Refunded));
    }

    // ------------------------------------------------------------------ EIP-712

    /// @dev Locks the exact encoding the backend must reproduce when signing quotes.
    function test_hashQuote_matchesIndependentEip712Encoding() public view {
        IGlobalPaySettlement.Quote memory quote = _quote(QUOTE_ID, AMOUNT);

        bytes32 typeHash = keccak256(
            "Quote(bytes32 quoteId,address payer,address token,uint256 tokenAmount,bytes3 fiatCurrency,uint256 fiatAmount,bytes32 merchantRefHash,uint64 expiresAt)"
        );
        bytes32 domainSeparator = keccak256(
            abi.encode(
                keccak256(
                    "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"
                ),
                keccak256("GlobalPay Settlement"),
                keccak256("1"),
                block.chainid,
                address(settlement)
            )
        );
        bytes32 structHash = keccak256(
            abi.encode(
                typeHash,
                quote.quoteId,
                quote.payer,
                quote.token,
                quote.tokenAmount,
                quote.fiatCurrency,
                quote.fiatAmount,
                quote.merchantRefHash,
                quote.expiresAt
            )
        );

        assertEq(settlement.QUOTE_TYPEHASH(), typeHash);
        assertEq(
            settlement.hashQuote(quote),
            keccak256(abi.encodePacked("\x19\x01", domainSeparator, structHash))
        );

        (, string memory name, string memory version, uint256 chainId, address verifier,,) =
            settlement.eip712Domain();
        assertEq(name, "GlobalPay Settlement");
        assertEq(version, "1");
        assertEq(chainId, block.chainid);
        assertEq(verifier, address(settlement));
    }

    // ---------------------------------------------------------- quote rejection

    function test_revert_quoteExpiredAtExpiresAt() public {
        IGlobalPaySettlement.Quote memory quote = _quote(QUOTE_ID, AMOUNT);
        (bytes memory quoteSig, IGlobalPaySettlement.Authorization memory auth) = _signed(quote);

        vm.warp(quote.expiresAt);
        vm.expectRevert(
            abi.encodeWithSelector(
                IGlobalPaySettlement.QuoteExpired.selector, QUOTE_ID, quote.expiresAt
            )
        );
        settlement.pay(quote, quoteSig, auth);
    }

    function testFuzz_revert_anyTimeAfterExpiry(uint256 delay) public {
        delay = bound(delay, 0, 365 days);
        IGlobalPaySettlement.Quote memory quote = _quote(QUOTE_ID, AMOUNT);
        (bytes memory quoteSig, IGlobalPaySettlement.Authorization memory auth) = _signed(quote);

        vm.warp(quote.expiresAt + delay);
        vm.expectRevert(
            abi.encodeWithSelector(
                IGlobalPaySettlement.QuoteExpired.selector, QUOTE_ID, quote.expiresAt
            )
        );
        settlement.pay(quote, quoteSig, auth);
    }

    function test_revert_replayedQuote() public {
        IGlobalPaySettlement.Quote memory quote = _quote(QUOTE_ID, AMOUNT);
        _pay(quote);
        (bytes memory quoteSig, IGlobalPaySettlement.Authorization memory auth) = _signed(quote);

        vm.expectRevert(
            abi.encodeWithSelector(IGlobalPaySettlement.QuoteAlreadyUsed.selector, QUOTE_ID)
        );
        settlement.pay(quote, quoteSig, auth);
    }

    function test_revert_quoteSignedByUnknownKey() public {
        IGlobalPaySettlement.Quote memory quote = _quote(QUOTE_ID, AMOUNT);
        bytes memory quoteSig = _signQuote(OTHER_PK, quote);
        IGlobalPaySettlement.Authorization memory auth = _authorize(PAYER_PK, quote);

        vm.expectRevert(
            abi.encodeWithSelector(
                IGlobalPaySettlement.InvalidQuoteSigner.selector, vm.addr(OTHER_PK)
            )
        );
        settlement.pay(quote, quoteSig, auth);
    }

    function test_revert_malformedQuoteSignature() public {
        IGlobalPaySettlement.Quote memory quote = _quote(QUOTE_ID, AMOUNT);
        IGlobalPaySettlement.Authorization memory auth = _authorize(PAYER_PK, quote);

        vm.expectRevert(
            abi.encodeWithSelector(IGlobalPaySettlement.InvalidQuoteSigner.selector, address(0))
        );
        settlement.pay(quote, hex"1234", auth);
    }

    /// @dev Changing any signed field after signing must invalidate the quote signature.
    function test_revert_tamperedQuote() public {
        IGlobalPaySettlement.Quote memory quote = _quote(QUOTE_ID, AMOUNT);
        (bytes memory quoteSig, IGlobalPaySettlement.Authorization memory auth) = _signed(quote);

        IGlobalPaySettlement.Quote memory tampered = _quote(QUOTE_ID, AMOUNT - 1);
        _expectRejected(tampered, quoteSig, auth);

        tampered = _quote(QUOTE_ID, AMOUNT);
        tampered.payer = stranger;
        _expectRejected(tampered, quoteSig, auth);

        tampered = _quote(QUOTE_ID, AMOUNT);
        tampered.fiatAmount = FIAT_AMOUNT * 2;
        _expectRejected(tampered, quoteSig, auth);

        tampered = _quote(QUOTE_ID, AMOUNT);
        tampered.fiatCurrency = bytes3("USD");
        _expectRejected(tampered, quoteSig, auth);

        tampered = _quote(QUOTE_ID, AMOUNT);
        tampered.merchantRefHash = keccak256("biller:someone-else");
        _expectRejected(tampered, quoteSig, auth);

        tampered = _quote(QUOTE_ID, AMOUNT);
        tampered.expiresAt += 3600;
        _expectRejected(tampered, quoteSig, auth);
    }

    function _expectRejected(
        IGlobalPaySettlement.Quote memory quote,
        bytes memory quoteSig,
        IGlobalPaySettlement.Authorization memory auth
    ) internal {
        vm.expectPartialRevert(IGlobalPaySettlement.InvalidQuoteSigner.selector);
        settlement.pay(quote, quoteSig, auth);
    }

    function test_revert_userAuthorizationFromAnotherWallet() public {
        IGlobalPaySettlement.Quote memory quote = _quote(QUOTE_ID, AMOUNT);
        bytes memory quoteSig = _signQuote(QUOTE_SIGNER_PK, quote);
        IGlobalPaySettlement.Authorization memory auth = _authorize(OTHER_PK, quote);

        vm.expectRevert(
            abi.encodeWithSelector(
                MockUSDC3009.InvalidAuthorizationSignature.selector, vm.addr(OTHER_PK), payer
            )
        );
        settlement.pay(quote, quoteSig, auth);

        assertEq(uint8(_status(QUOTE_ID)), uint8(IGlobalPaySettlement.PaymentStatus.None));
    }

    function test_revert_tokenNotAllowed() public {
        MockUSDC3009 otherToken = new MockUSDC3009();
        IGlobalPaySettlement.Quote memory quote = _quote(QUOTE_ID, AMOUNT);
        quote.token = address(otherToken);
        (bytes memory quoteSig, IGlobalPaySettlement.Authorization memory auth) = _signed(quote);

        vm.expectRevert(
            abi.encodeWithSelector(
                IGlobalPaySettlement.TokenNotAllowed.selector, address(otherToken)
            )
        );
        settlement.pay(quote, quoteSig, auth);
    }

    function test_revert_zeroAmount() public {
        IGlobalPaySettlement.Quote memory quote = _quote(QUOTE_ID, 0);
        (bytes memory quoteSig, IGlobalPaySettlement.Authorization memory auth) = _signed(quote);

        vm.expectRevert(IGlobalPaySettlement.ZeroAmount.selector);
        settlement.pay(quote, quoteSig, auth);
    }

    function test_revert_tokenThatDoesNotTransfer() public {
        NoopToken3009 noop = new NoopToken3009();
        vm.prank(admin);
        settlement.setTokenAllowed(address(noop), true);

        IGlobalPaySettlement.Quote memory quote = _quote(QUOTE_ID, AMOUNT);
        quote.token = address(noop);
        (bytes memory quoteSig, IGlobalPaySettlement.Authorization memory auth) = _signed(quote);

        vm.expectRevert(
            abi.encodeWithSelector(IGlobalPaySettlement.UnexpectedTokenTransfer.selector, AMOUNT, 0)
        );
        settlement.pay(quote, quoteSig, auth);
    }

    // -------------------------------------------------------------------- pause

    function test_revert_payWhenPaused() public {
        IGlobalPaySettlement.Quote memory quote = _quote(QUOTE_ID, AMOUNT);
        (bytes memory quoteSig, IGlobalPaySettlement.Authorization memory auth) = _signed(quote);
        vm.prank(pauser);
        settlement.pause();

        vm.expectRevert(Pausable.EnforcedPause.selector);
        settlement.pay(quote, quoteSig, auth);
    }

    function test_settleAndRefund_stillWorkWhenPaused() public {
        _pay(_quote(QUOTE_ID, AMOUNT));
        _pay(_quote(QUOTE_ID_2, AMOUNT));
        vm.prank(pauser);
        settlement.pause();

        vm.startPrank(operator);
        settlement.markSettled(QUOTE_ID);
        settlement.refund(QUOTE_ID_2);
        vm.stopPrank();

        assertEq(usdc.balanceOf(treasury), AMOUNT);
        assertEq(usdc.balanceOf(payer), PAYER_FUNDS - AMOUNT);
        assertEq(usdc.balanceOf(address(settlement)), 0);
    }

    function test_revert_onlyPauserCanPause() public {
        bytes32 pauserRole = settlement.PAUSER_ROLE();
        vm.prank(stranger);
        vm.expectRevert(_unauthorized(stranger, pauserRole));
        settlement.pause();
    }

    function test_onlyAdminCanUnpause() public {
        bytes32 adminRole = settlement.DEFAULT_ADMIN_ROLE();
        vm.prank(pauser);
        settlement.pause();

        vm.prank(pauser);
        vm.expectRevert(_unauthorized(pauser, adminRole));
        settlement.unpause();

        vm.prank(admin);
        settlement.unpause();
        assertFalse(settlement.paused());
    }

    // ----------------------------------------------------------- status rules

    function test_revert_settleOrRefundUnknownPayment() public {
        vm.startPrank(operator);
        vm.expectRevert(_invalidStatus(QUOTE_ID, IGlobalPaySettlement.PaymentStatus.None));
        settlement.markSettled(QUOTE_ID);
        vm.expectRevert(_invalidStatus(QUOTE_ID, IGlobalPaySettlement.PaymentStatus.None));
        settlement.refund(QUOTE_ID);
        vm.stopPrank();
    }

    function test_revert_settleOrRefundAfterSettled() public {
        _pay(_quote(QUOTE_ID, AMOUNT));
        vm.startPrank(operator);
        settlement.markSettled(QUOTE_ID);

        vm.expectRevert(_invalidStatus(QUOTE_ID, IGlobalPaySettlement.PaymentStatus.Settled));
        settlement.markSettled(QUOTE_ID);
        vm.expectRevert(_invalidStatus(QUOTE_ID, IGlobalPaySettlement.PaymentStatus.Settled));
        settlement.refund(QUOTE_ID);
        vm.stopPrank();
    }

    function test_revert_settleOrRefundAfterRefunded() public {
        _pay(_quote(QUOTE_ID, AMOUNT));
        vm.startPrank(operator);
        settlement.refund(QUOTE_ID);

        vm.expectRevert(_invalidStatus(QUOTE_ID, IGlobalPaySettlement.PaymentStatus.Refunded));
        settlement.refund(QUOTE_ID);
        vm.expectRevert(_invalidStatus(QUOTE_ID, IGlobalPaySettlement.PaymentStatus.Refunded));
        settlement.markSettled(QUOTE_ID);
        vm.stopPrank();
    }

    function test_revert_onlyOperatorSettlesOrRefunds() public {
        _pay(_quote(QUOTE_ID, AMOUNT));
        bytes32 operatorRole = settlement.OPERATOR_ROLE();

        vm.startPrank(stranger);
        vm.expectRevert(_unauthorized(stranger, operatorRole));
        settlement.markSettled(QUOTE_ID);
        vm.expectRevert(_unauthorized(stranger, operatorRole));
        settlement.refund(QUOTE_ID);
        vm.stopPrank();
    }

    // -------------------------------------------------------------------- admin

    function test_admin_updatesTreasury() public {
        address newTreasury = makeAddr("newTreasury");
        vm.expectEmit(address(settlement));
        emit IGlobalPaySettlement.TreasuryUpdated(newTreasury);
        vm.prank(admin);
        settlement.setTreasury(newTreasury);
        assertEq(settlement.treasury(), newTreasury);

        _pay(_quote(QUOTE_ID, AMOUNT));
        vm.prank(operator);
        settlement.markSettled(QUOTE_ID);
        assertEq(usdc.balanceOf(newTreasury), AMOUNT);
    }

    function test_admin_disallowsToken() public {
        vm.expectEmit(address(settlement));
        emit IGlobalPaySettlement.TokenAllowed(address(usdc), false);
        vm.prank(admin);
        settlement.setTokenAllowed(address(usdc), false);
        assertFalse(settlement.isTokenAllowed(address(usdc)));

        IGlobalPaySettlement.Quote memory quote = _quote(QUOTE_ID, AMOUNT);
        (bytes memory quoteSig, IGlobalPaySettlement.Authorization memory auth) = _signed(quote);
        vm.expectRevert(
            abi.encodeWithSelector(IGlobalPaySettlement.TokenNotAllowed.selector, address(usdc))
        );
        settlement.pay(quote, quoteSig, auth);
    }

    function test_revert_onlyAdminConfigures() public {
        bytes32 adminRole = settlement.DEFAULT_ADMIN_ROLE();
        vm.startPrank(stranger);
        vm.expectRevert(_unauthorized(stranger, adminRole));
        settlement.setTreasury(stranger);
        vm.expectRevert(_unauthorized(stranger, adminRole));
        settlement.setTokenAllowed(address(usdc), false);
        vm.stopPrank();
    }

    function test_revert_constructorZeroAddresses() public {
        vm.expectRevert(IGlobalPaySettlement.ZeroAddress.selector);
        new GlobalPaySettlement(address(0), treasury);
        vm.expectRevert(IGlobalPaySettlement.ZeroAddress.selector);
        new GlobalPaySettlement(admin, address(0));
    }

    function test_revert_settersRejectZeroAddress() public {
        vm.startPrank(admin);
        vm.expectRevert(IGlobalPaySettlement.ZeroAddress.selector);
        settlement.setTreasury(address(0));
        vm.expectRevert(IGlobalPaySettlement.ZeroAddress.selector);
        settlement.setTokenAllowed(address(0), true);
        vm.stopPrank();
    }

    // --------------------------------------------------------------------- fuzz

    function testFuzz_payThenSettle_conservesBalances(uint256 amount) public {
        amount = bound(amount, 1, 1e15);
        usdc.mint(payer, amount);
        uint256 payerBefore = usdc.balanceOf(payer);

        _pay(_quote(QUOTE_ID, amount));
        vm.prank(operator);
        settlement.markSettled(QUOTE_ID);

        assertEq(usdc.balanceOf(payer), payerBefore - amount);
        assertEq(usdc.balanceOf(treasury), amount);
        assertEq(usdc.balanceOf(address(settlement)), 0);
    }

    function testFuzz_payThenRefund_returnsEverything(uint256 amount) public {
        amount = bound(amount, 1, 1e15);
        usdc.mint(payer, amount);
        uint256 payerBefore = usdc.balanceOf(payer);

        _pay(_quote(QUOTE_ID, amount));
        vm.prank(operator);
        settlement.refund(QUOTE_ID);

        assertEq(usdc.balanceOf(payer), payerBefore);
        assertEq(usdc.balanceOf(treasury), 0);
        assertEq(usdc.balanceOf(address(settlement)), 0);
    }
}
