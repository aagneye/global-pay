import { randomBytes } from 'node:crypto';
import { type Address, getAddress, verifyMessage } from 'viem';
import { createSiweMessage, generateSiweNonce, parseSiweMessage, validateSiweMessage } from 'viem/siwe';
import { decodeBase64, implicitAccountOf } from '../../adapters/near/keys.js';
import { verifyNep413 } from '../../adapters/near/nep413.js';
import type { User } from '../../domain/user.js';
import type { NearOnboarding } from '../../ports/near-chain.js';
import type { SiweNonceRepository, UserRepository } from '../../ports/repositories.js';
import { AppError } from '../../shared/errors.js';
import { type SettlementRail, isHex, parseWallet } from '../../shared/schemas.js';
import type { AccessTokens } from './tokens.js';

export interface AuthServiceDeps {
  users: UserRepository;
  nonces: SiweNonceRepository;
  tokens: AccessTokens;
  chainId: number;
  /** EIP-4361 `domain` the message must name, e.g. "globalpay.local". On NEAR, the NEP-413 recipient. */
  domain: string;
  /** `evm` (default): Sign-In with Ethereum. `near`: NEP-413 with a NEAR implicit account. */
  rail?: SettlementRail;
  /** NEAR rail: run after each sign-in, before the token is returned (testnet faucet). */
  onboarding?: NearOnboarding;
  /** How long sign-in waits for onboarding (25 s); after that it finishes in the background. */
  onboardingTimeoutMs?: number;
  /** How long a nonce can be used. */
  nonceTtlSeconds?: number;
  now?: () => Date;
}

export interface NonceResponse {
  nonce: string;
  /** The exact message for the wallet to sign: EIP-4361 (EVM) or the NEP-413 `message` (NEAR). */
  message: string;
  expiresAt: Date;
}

export interface SignInResponse {
  token: string;
  expiresAt: Date;
  user: User;
}

const STATEMENT = 'Sign in to GlobalPay.';

/** The NEAR sign-in message: short and readable, naming the domain, account, nonce and validity. */
const NEAR_MESSAGE =
  /^(?<domain>\S+) wants you to sign in to GlobalPay with your NEAR account:\n(?<account>[0-9a-f]{64})\n\nNonce: (?<nonce>[0-9a-f]{64})\nIssued At: (?<issuedAt>\S+)\nExpiration Time: (?<expiresAt>\S+)$/;

function nearSignInMessage(fields: { domain: string; account: string; nonce: string; issuedAt: string; expiresAt: string }): string {
  return (
    `${fields.domain} wants you to sign in to GlobalPay with your NEAR account:\n${fields.account}\n\n` +
    `Nonce: ${fields.nonce}\nIssued At: ${fields.issuedAt}\nExpiration Time: ${fields.expiresAt}`
  );
}

/**
 * Sign-in: one-time nonce → signed message → JWT.
 * - EVM rail: Sign-In with Ethereum (EIP-4361).
 * - NEAR rail: NEP-413. The app signs {message, nonce, recipient: domain} with the key of its implicit
 *   account; the account *is* the key, so the check is offline.
 *
 * The server builds the message, so the app only has to sign it. Every field is still checked
 * on the way back in: domain, expiry, signature, and the nonce (once, for this address).
 */
export class AuthService {
  private readonly deps: AuthServiceDeps;
  private readonly uri: string;
  private readonly nonceTtlSeconds: number;
  private readonly now: () => Date;

  constructor(deps: AuthServiceDeps) {
    this.deps = deps;
    this.uri = `https://${deps.domain}`;
    this.nonceTtlSeconds = deps.nonceTtlSeconds ?? 300;
    this.now = deps.now ?? (() => new Date());
  }

  private get rail(): SettlementRail {
    return this.deps.rail ?? 'evm';
  }

  async createNonce(address: Address): Promise<NonceResponse> {
    parseWallet(this.rail, address);
    const issuedAt = this.now();
    const expiresAt = new Date(issuedAt.getTime() + this.nonceTtlSeconds * 1000);

    if (this.rail === 'near') {
      const nonce = randomBytes(32).toString('hex');
      await this.deps.nonces.create({ nonce, address, expiresAt });
      const message = nearSignInMessage({
        domain: this.deps.domain,
        account: address,
        nonce,
        issuedAt: issuedAt.toISOString(),
        expiresAt: expiresAt.toISOString(),
      });
      return { nonce, message, expiresAt };
    }

    const nonce = generateSiweNonce();
    await this.deps.nonces.create({ nonce, address, expiresAt });
    const message = createSiweMessage({
      address: getAddress(address),
      chainId: this.deps.chainId,
      domain: this.deps.domain,
      uri: this.uri,
      version: '1',
      nonce,
      statement: STATEMENT,
      issuedAt,
      expirationTime: expiresAt,
    });
    return { nonce, message, expiresAt };
  }

  /** `publicKey` is the NEAR rail's "ed25519:<base58>" signing key; the EVM rail ignores it. */
  async verify(message: string, signature: string, publicKey?: string): Promise<SignInResponse> {
    if (this.rail === 'near') return this.verifyNear(message, signature, publicKey);

    if (!isHex(signature)) throw new AppError('invalid_request', 'signature: expected 0x-prefixed hex', 400);
    const now = this.now();
    const fields = parseSiweMessage(message);
    const { address, nonce } = fields;
    if (
      !address ||
      !nonce ||
      fields.chainId !== this.deps.chainId ||
      fields.uri !== this.uri ||
      !validateSiweMessage({ message: fields, domain: this.deps.domain, time: now })
    ) {
      throw new AppError('invalid_siwe_message', 'The sign-in message is invalid, expired or for another app', 401);
    }

    // Offline check: works for EOAs, which is what embedded wallets use.
    // Smart-contract wallets (ERC-1271) would need an on-chain check.
    const valid = await verifyMessage({ address, message, signature }).catch(() => false);
    if (!valid) throw new AppError('invalid_signature', 'The signature does not match the address', 401);

    return this.signIn(nonce, address, now);
  }

  /**
   * NEP-413: the message must be the one createNonce wrote (rebuilt from its fields), for this domain and
   * unexpired; the key must be the account's own (hex(key) == account); the signature must be the key's
   * over {message, nonce, recipient: domain}; then the nonce is used up as for SIWE.
   */
  private async verifyNear(message: string, signature: string, publicKey: string | undefined): Promise<SignInResponse> {
    if (!publicKey) throw new AppError('invalid_request', 'publicKey is required on the NEAR rail', 400);
    const now = this.now();
    const fields = NEAR_MESSAGE.exec(message)?.groups as
      | { domain: string; account: string; nonce: string; issuedAt: string; expiresAt: string }
      | undefined;
    if (
      !fields ||
      fields.domain !== this.deps.domain ||
      nearSignInMessage(fields) !== message ||
      !(new Date(fields.expiresAt).getTime() > now.getTime())
    ) {
      throw new AppError('invalid_siwe_message', 'The sign-in message is invalid, expired or for another app', 401);
    }

    const signatureBytes = decodeBase64(signature);
    const valid =
      signatureBytes !== null &&
      implicitAccountOf(publicKey) === fields.account &&
      verifyNep413(
        { message, nonce: Buffer.from(fields.nonce, 'hex'), recipient: this.deps.domain },
        publicKey,
        signatureBytes,
      );
    if (!valid) throw new AppError('invalid_signature', 'The signature does not match the account', 401);

    const response = await this.signIn(fields.nonce, fields.account as Address, now);
    await this.onboard(response.user.walletAddress);
    return response;
  }

  /**
   * Testnet onboarding before the token is returned, so the first quote finds the account funded. It does
   * nothing for an onboarded account, never throws, and is waited for at most `onboardingTimeoutMs`
   * (then it carries on in the background).
   */
  private async onboard(accountId: string): Promise<void> {
    const { onboarding } = this.deps;
    if (!onboarding) return;
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, this.deps.onboardingTimeoutMs ?? 25_000);
    });
    await Promise.race([onboarding.onboard(accountId), timeout]);
    clearTimeout(timer);
  }

  private async signIn(nonce: string, address: Address, now: Date): Promise<SignInResponse> {
    // Checked after the signature, so nobody can burn another wallet's nonce.
    if (!(await this.deps.nonces.consume(nonce, address, now))) {
      throw new AppError('invalid_nonce', 'The sign-in nonce is unknown, used or expired; request a new one', 401);
    }
    const user = await this.deps.users.upsertByWallet(address);
    const { token, expiresAt } = await this.deps.tokens.issue({ userId: user.id, walletAddress: user.walletAddress });
    return { token, expiresAt, user };
  }
}
