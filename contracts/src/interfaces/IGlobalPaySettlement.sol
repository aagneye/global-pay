// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

/// @title IGlobalPaySettlement
/// @notice Receives stablecoin payments against backend-signed quotes and tracks
///         each payment until the local-currency payout settles or fails.
/// @dev Flow (see docs/architecture.md):
///      1. The backend signs a `Quote` (EIP-712) with a QUOTE_SIGNER_ROLE key.
///      2. The payer signs a USDC `ReceiveWithAuthorization` with nonce = quoteId.
///      3. Anyone (normally the GlobalPay relayer) calls `pay`. The contract pulls the tokens.
///      4. After the off-chain payout, an OPERATOR_ROLE account calls `markSettled`
///         (tokens go to the treasury) or `refund` (tokens go back to the payer).
interface IGlobalPaySettlement {
    enum PaymentStatus {
        None,
        Paid,
        Settled,
        Refunded
    }

    /// @notice A price quote signed by the GlobalPay backend.
    /// @dev EIP-712 type:
    ///      Quote(bytes32 quoteId,address payer,address token,uint256 tokenAmount,
    ///            bytes3 fiatCurrency,uint256 fiatAmount,bytes32 merchantRefHash,uint64 expiresAt)
    struct Quote {
        bytes32 quoteId; // unique per quote; also the EIP-3009 nonce
        address payer; // wallet that pays
        address token; // allowlisted stablecoin (USDC)
        uint256 tokenAmount; // token base units (USDC: 6 decimals)
        bytes3 fiatCurrency; // ISO 4217 code, e.g. "THB"
        uint256 fiatAmount; // fiat minor units (THB: satang)
        bytes32 merchantRefHash; // keccak256 of the normalised merchant / biller ID
        uint64 expiresAt; // unix seconds; valid while block.timestamp < expiresAt (like EIP-3009 validBefore)
    }

    /// @notice The payer's EIP-3009 ReceiveWithAuthorization signature.
    /// @dev from = quote.payer, to = this contract, value = quote.tokenAmount, nonce = quote.quoteId.
    ///      The backend sets validBefore = quote.expiresAt so both signatures expire together.
    struct Authorization {
        uint256 validAfter;
        uint256 validBefore;
        uint8 v;
        bytes32 r;
        bytes32 s;
    }

    struct Payment {
        address payer;
        address token;
        uint256 tokenAmount;
        PaymentStatus status;
    }

    event PaymentReceived(
        bytes32 indexed quoteId,
        address indexed payer,
        address indexed token,
        uint256 tokenAmount,
        bytes3 fiatCurrency,
        uint256 fiatAmount,
        bytes32 merchantRefHash
    );
    event PaymentSettled(bytes32 indexed quoteId, address indexed treasury, uint256 tokenAmount);
    event PaymentRefunded(bytes32 indexed quoteId, address indexed payer, uint256 tokenAmount);
    event TokenAllowed(address indexed token, bool allowed);
    event TreasuryUpdated(address indexed treasury);

    error QuoteExpired(bytes32 quoteId, uint64 expiresAt);
    error QuoteAlreadyUsed(bytes32 quoteId);
    error InvalidQuoteSigner(address recovered);
    error TokenNotAllowed(address token);
    error InvalidPaymentStatus(bytes32 quoteId, PaymentStatus status);
    error ZeroAddress();
    error ZeroAmount();
    /// @dev The token moved a different amount than authorised (misconfigured or non-standard token).
    error UnexpectedTokenTransfer(uint256 expected, uint256 received);

    /// @notice Pull the payer's tokens for a signed quote and record the payment as Paid.
    /// @dev Permissionless: the two signatures authorise the payment, not the caller.
    function pay(Quote calldata quote, bytes calldata quoteSignature, Authorization calldata auth)
        external;

    /// @notice Payout succeeded: move the payment's tokens to the treasury. OPERATOR_ROLE only.
    function markSettled(bytes32 quoteId) external;

    /// @notice Payout failed: return the payment's tokens to the payer. OPERATOR_ROLE only.
    function refund(bytes32 quoteId) external;

    /// @notice Allow or disallow a stablecoin. DEFAULT_ADMIN_ROLE only.
    function setTokenAllowed(address token, bool allowed) external;

    /// @notice Change where settled funds go. DEFAULT_ADMIN_ROLE only.
    function setTreasury(address treasury) external;

    function treasury() external view returns (address);

    function isTokenAllowed(address token) external view returns (bool);

    function paymentOf(bytes32 quoteId) external view returns (Payment memory);

    /// @notice EIP-712 digest of a quote. The backend tests its signatures against this.
    function hashQuote(Quote calldata quote) external view returns (bytes32);
}
