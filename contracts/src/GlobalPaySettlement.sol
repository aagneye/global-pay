// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {IERC3009} from "./interfaces/IERC3009.sol";
import {IGlobalPaySettlement} from "./interfaces/IGlobalPaySettlement.sol";

/// @title GlobalPaySettlement
/// @notice Holds a stablecoin payment from the moment the user pays until GlobalPay's
///         local-currency payout either succeeds (funds go to the treasury) or fails
///         (funds go back to the payer). See docs/architecture.md.
/// @dev Not upgradeable by design (docs/adr/0006). Roles:
///      - DEFAULT_ADMIN_ROLE: roles, treasury, token allowlist, unpause
///      - QUOTE_SIGNER_ROLE:  keys whose quote signatures `pay` accepts
///      - OPERATOR_ROLE:      `markSettled` and `refund`
///      - PAUSER_ROLE:        `pause` (new payments only; settle/refund keep working)
contract GlobalPaySettlement is
    IGlobalPaySettlement,
    AccessControl,
    Pausable,
    ReentrancyGuard,
    EIP712
{
    using SafeERC20 for IERC20;

    bytes32 public constant QUOTE_SIGNER_ROLE = keccak256("QUOTE_SIGNER_ROLE");
    bytes32 public constant OPERATOR_ROLE = keccak256("OPERATOR_ROLE");
    bytes32 public constant PAUSER_ROLE = keccak256("PAUSER_ROLE");

    bytes32 public constant QUOTE_TYPEHASH = keccak256(
        "Quote(bytes32 quoteId,address payer,address token,uint256 tokenAmount,bytes3 fiatCurrency,uint256 fiatAmount,bytes32 merchantRefHash,uint64 expiresAt)"
    );

    address private _treasury;
    mapping(address token => bool allowed) private _allowedTokens;
    mapping(bytes32 quoteId => Payment payment) private _payments;

    constructor(address admin, address treasury_) EIP712("GlobalPay Settlement", "1") {
        if (admin == address(0) || treasury_ == address(0)) revert ZeroAddress();
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _treasury = treasury_;
        emit TreasuryUpdated(treasury_);
    }

    // ---------------------------------------------------------------- payments

    /// @inheritdoc IGlobalPaySettlement
    function pay(Quote calldata quote, bytes calldata quoteSignature, Authorization calldata auth)
        external
        nonReentrant
        whenNotPaused
    {
        _checkQuote(quote, quoteSignature);

        // Checks-effects-interactions: state and event before the external token call.
        // If the transfer reverts, the whole transaction (event included) is rolled back.
        _payments[quote.quoteId] = Payment({
            payer: quote.payer,
            token: quote.token,
            tokenAmount: quote.tokenAmount,
            status: PaymentStatus.Paid
        });
        // Reviewed: no external call precedes this event (_checkQuote only uses the ecrecover
        // precompile via OpenZeppelin's internal ECDSA library), and pay is nonReentrant.
        // forge-lint: disable-next-item(reentrancy-events)
        emit PaymentReceived(
            quote.quoteId,
            quote.payer,
            quote.token,
            quote.tokenAmount,
            quote.fiatCurrency,
            quote.fiatAmount,
            quote.merchantRefHash
        );

        _pullTokens(quote, auth);
    }

    /// @inheritdoc IGlobalPaySettlement
    function markSettled(bytes32 quoteId) external nonReentrant onlyRole(OPERATOR_ROLE) {
        Payment storage payment = _requirePaid(quoteId);
        payment.status = PaymentStatus.Settled;

        address treasury_ = _treasury;
        uint256 amount = payment.tokenAmount;
        emit PaymentSettled(quoteId, treasury_, amount);
        IERC20(payment.token).safeTransfer(treasury_, amount);
    }

    /// @inheritdoc IGlobalPaySettlement
    function refund(bytes32 quoteId) external nonReentrant onlyRole(OPERATOR_ROLE) {
        Payment storage payment = _requirePaid(quoteId);
        payment.status = PaymentStatus.Refunded;

        address payer = payment.payer;
        uint256 amount = payment.tokenAmount;
        emit PaymentRefunded(quoteId, payer, amount);
        IERC20(payment.token).safeTransfer(payer, amount);
    }

    // ------------------------------------------------------------------- admin

    /// @notice Stop new payments. Settling and refunding still work.
    function pause() external onlyRole(PAUSER_ROLE) {
        _pause();
    }

    /// @notice Resume payments. Admin only, so a pauser key cannot undo an emergency stop.
    function unpause() external onlyRole(DEFAULT_ADMIN_ROLE) {
        _unpause();
    }

    /// @inheritdoc IGlobalPaySettlement
    function setTokenAllowed(address token, bool allowed) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (token == address(0)) revert ZeroAddress();
        _allowedTokens[token] = allowed;
        emit TokenAllowed(token, allowed);
    }

    /// @inheritdoc IGlobalPaySettlement
    function setTreasury(address treasury_) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (treasury_ == address(0)) revert ZeroAddress();
        _treasury = treasury_;
        emit TreasuryUpdated(treasury_);
    }

    // ------------------------------------------------------------------- views

    function treasury() external view returns (address) {
        return _treasury;
    }

    function isTokenAllowed(address token) external view returns (bool) {
        return _allowedTokens[token];
    }

    function paymentOf(bytes32 quoteId) external view returns (Payment memory) {
        return _payments[quoteId];
    }

    /// @inheritdoc IGlobalPaySettlement
    function hashQuote(Quote calldata quote) external view returns (bytes32) {
        return _hashTypedDataV4(_structHash(quote));
    }

    // ---------------------------------------------------------------- internal

    function _checkQuote(Quote calldata quote, bytes calldata quoteSignature) private view {
        if (quote.tokenAmount == 0) revert ZeroAmount();
        // Reviewed: validators can shift timestamps by seconds, which is harmless for a 60s quote.
        // forge-lint: disable-next-line(block-timestamp)
        if (block.timestamp >= quote.expiresAt) {
            revert QuoteExpired(quote.quoteId, quote.expiresAt);
        }
        if (!_allowedTokens[quote.token]) revert TokenNotAllowed(quote.token);
        if (_payments[quote.quoteId].status != PaymentStatus.None) {
            revert QuoteAlreadyUsed(quote.quoteId);
        }

        (address signer, ECDSA.RecoverError err,) =
            ECDSA.tryRecover(_hashTypedDataV4(_structHash(quote)), quoteSignature);
        if (err != ECDSA.RecoverError.NoError || !hasRole(QUOTE_SIGNER_ROLE, signer)) {
            revert InvalidQuoteSigner(signer);
        }
    }

    function _pullTokens(Quote calldata quote, Authorization calldata auth) private {
        IERC20 token = IERC20(quote.token);
        uint256 balanceBefore = token.balanceOf(address(this));

        // nonce = quoteId binds the user's authorisation to exactly this quote.
        IERC3009(quote.token)
            .receiveWithAuthorization(
                quote.payer,
                address(this),
                quote.tokenAmount,
                auth.validAfter,
                auth.validBefore,
                quote.quoteId,
                auth.v,
                auth.r,
                auth.s
            );

        uint256 received = token.balanceOf(address(this)) - balanceBefore;
        if (received != quote.tokenAmount) {
            revert UnexpectedTokenTransfer(quote.tokenAmount, received);
        }
    }

    function _requirePaid(bytes32 quoteId) private view returns (Payment storage payment) {
        payment = _payments[quoteId];
        if (payment.status != PaymentStatus.Paid) {
            revert InvalidPaymentStatus(quoteId, payment.status);
        }
    }

    function _structHash(Quote calldata quote) private pure returns (bytes32) {
        return keccak256(
            abi.encode(
                QUOTE_TYPEHASH,
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
    }
}
