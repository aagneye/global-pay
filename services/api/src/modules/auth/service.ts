import { type Address, type Hex, getAddress, verifyMessage } from 'viem';
import { createSiweMessage, generateSiweNonce, parseSiweMessage, validateSiweMessage } from 'viem/siwe';
import type { User } from '../../domain/user.js';
import type { SiweNonceRepository, UserRepository } from '../../ports/repositories.js';
import { AppError } from '../../shared/errors.js';
import type { AccessTokens } from './tokens.js';

export interface AuthServiceDeps {
  users: UserRepository;
  nonces: SiweNonceRepository;
  tokens: AccessTokens;
  chainId: number;
  /** EIP-4361 `domain` the message must name, e.g. "globalpay.local". */
  domain: string;
  /** How long a nonce can be used. */
  nonceTtlSeconds?: number;
  now?: () => Date;
}

export interface NonceResponse {
  nonce: string;
  /** The exact EIP-4361 message for the wallet to sign. */
  message: string;
  expiresAt: Date;
}

export interface SignInResponse {
  token: string;
  expiresAt: Date;
  user: User;
}

const STATEMENT = 'Sign in to GlobalPay.';

/**
 * Sign-In with Ethereum (EIP-4361): one-time nonce → signed message → JWT.
 *
 * The server builds the message, so the app only has to sign it. Every field is still checked
 * on the way back in: domain, URI, chain, expiry, signature, and the nonce (once, for this address).
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

  async createNonce(address: Address): Promise<NonceResponse> {
    const issuedAt = this.now();
    const expiresAt = new Date(issuedAt.getTime() + this.nonceTtlSeconds * 1000);
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

  async verify(message: string, signature: Hex): Promise<SignInResponse> {
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

    // Checked after the signature, so nobody can burn another wallet's nonce.
    if (!(await this.deps.nonces.consume(nonce, address, now))) {
      throw new AppError('invalid_nonce', 'The sign-in nonce is unknown, used or expired; request a new one', 401);
    }

    const user = await this.deps.users.upsertByWallet(address);
    const { token, expiresAt } = await this.deps.tokens.issue({ userId: user.id, walletAddress: user.walletAddress });
    return { token, expiresAt, user };
  }
}
