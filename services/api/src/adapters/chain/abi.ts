import { parseAbi } from 'viem';

/**
 * ABI of contracts/src/interfaces/IGlobalPaySettlement.sol, plus the errors the contract
 * and its dependencies can revert with, so reverts decode to names.
 * test/integration checks it against the compiled contract.
 */
export const settlementAbi = parseAbi([
  'struct Quote { bytes32 quoteId; address payer; address token; uint256 tokenAmount; bytes3 fiatCurrency; uint256 fiatAmount; bytes32 merchantRefHash; uint64 expiresAt; }',
  'struct Authorization { uint256 validAfter; uint256 validBefore; uint8 v; bytes32 r; bytes32 s; }',
  'struct Payment { address payer; address token; uint256 tokenAmount; uint8 status; }',

  'function pay(Quote quote, bytes quoteSignature, Authorization auth)',
  'function markSettled(bytes32 quoteId)',
  'function refund(bytes32 quoteId)',
  'function paymentOf(bytes32 quoteId) view returns (Payment)',
  'function treasury() view returns (address)',
  'function isTokenAllowed(address token) view returns (bool)',
  'function hashQuote(Quote quote) view returns (bytes32)',

  'event PaymentReceived(bytes32 indexed quoteId, address indexed payer, address indexed token, uint256 tokenAmount, bytes3 fiatCurrency, uint256 fiatAmount, bytes32 merchantRefHash)',
  'event PaymentSettled(bytes32 indexed quoteId, address indexed treasury, uint256 tokenAmount)',
  'event PaymentRefunded(bytes32 indexed quoteId, address indexed payer, uint256 tokenAmount)',

  'error QuoteExpired(bytes32 quoteId, uint64 expiresAt)',
  'error QuoteAlreadyUsed(bytes32 quoteId)',
  'error InvalidQuoteSigner(address recovered)',
  'error TokenNotAllowed(address token)',
  'error InvalidPaymentStatus(bytes32 quoteId, uint8 status)',
  'error ZeroAddress()',
  'error ZeroAmount()',
  'error UnexpectedTokenTransfer(uint256 expected, uint256 received)',

  // OpenZeppelin
  'error AccessControlUnauthorizedAccount(address account, bytes32 neededRole)',
  'error EnforcedPause()',
  'error ReentrancyGuardReentrantCall()',
  'error ERC20InsufficientBalance(address sender, uint256 balance, uint256 needed)',
  'error SafeERC20FailedOperation(address token)',

  // EIP-3009 token (the local mock; Circle's USDC reverts with messages instead)
  'error CallerMustBePayee(address caller, address payee)',
  'error AuthorizationNotYetValid(uint256 validAfter)',
  'error AuthorizationExpired(uint256 validBefore)',
  'error AuthorizationAlreadyUsed(address authorizer, bytes32 nonce)',
  'error InvalidAuthorizationSignature(address recovered, address expected)',
]);

/** USDC's EIP-3009 transfer, which anyone may submit, plus the errors the local mock reverts with. */
export const usdcTransferAbi = parseAbi([
  'function transferWithAuthorization(address from, address to, uint256 value, uint256 validAfter, uint256 validBefore, bytes32 nonce, uint8 v, bytes32 r, bytes32 s)',
  'error AuthorizationNotYetValid(uint256 validAfter)',
  'error AuthorizationExpired(uint256 validBefore)',
  'error AuthorizationAlreadyUsed(address authorizer, bytes32 nonce)',
  'error InvalidAuthorizationSignature(address recovered, address expected)',
  'error ERC20InsufficientBalance(address sender, uint256 balance, uint256 needed)',
]);

export const erc20Abi = parseAbi([
  'function balanceOf(address owner) view returns (uint256)',
  'function name() view returns (string)',
  'function version() view returns (string)',
]);

/** `IGlobalPaySettlement.PaymentStatus`. */
export const ON_CHAIN_STATUS = ['None', 'Paid', 'Settled', 'Refunded'] as const;
export type OnChainStatus = (typeof ON_CHAIN_STATUS)[number];
