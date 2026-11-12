import { SignJWT, jwtVerify } from 'jose';
import type { Address } from 'viem';
import { AppError } from '../../shared/errors.js';

export interface AccessTokenClaims {
  userId: string;
  /** Lowercase wallet address the user signed in with. */
  walletAddress: Address;
}

export interface AccessTokensOptions {
  /** HMAC key, at least 32 characters (JWT_SECRET). */
  secret: string;
  ttlSeconds: number;
  now?: () => Date;
}

const ISSUER = 'globalpay-api';
const AUDIENCE = 'globalpay-app';
const ALGORITHM = 'HS256';

/** Short-lived bearer tokens (HS256 JWTs) issued after Sign-In with Ethereum. */
export class AccessTokens {
  private readonly key: Uint8Array;
  private readonly ttlSeconds: number;
  private readonly now: () => Date;

  constructor(options: AccessTokensOptions) {
    this.key = new TextEncoder().encode(options.secret);
    this.ttlSeconds = options.ttlSeconds;
    this.now = options.now ?? (() => new Date());
  }

  async issue(claims: AccessTokenClaims): Promise<{ token: string; expiresAt: Date }> {
    const issuedAt = Math.floor(this.now().getTime() / 1000);
    const expiresAt = issuedAt + this.ttlSeconds;
    const token = await new SignJWT({ wallet: claims.walletAddress })
      .setProtectedHeader({ alg: ALGORITHM })
      .setSubject(claims.userId)
      .setIssuer(ISSUER)
      .setAudience(AUDIENCE)
      .setIssuedAt(issuedAt)
      .setExpirationTime(expiresAt)
      .sign(this.key);
    return { token, expiresAt: new Date(expiresAt * 1000) };
  }

  /** Throws 401 `invalid_token` unless the token is ours, unexpired and well formed. */
  async verify(token: string): Promise<AccessTokenClaims> {
    try {
      const { payload } = await jwtVerify(token, this.key, {
        issuer: ISSUER,
        audience: AUDIENCE,
        algorithms: [ALGORITHM],
        currentDate: this.now(),
      });
      if (typeof payload.sub !== 'string' || typeof payload.wallet !== 'string') {
        throw new Error('missing claims');
      }
      return { userId: payload.sub, walletAddress: payload.wallet as Address };
    } catch {
      throw new AppError('invalid_token', 'The access token is invalid or expired; sign in again', 401);
    }
  }
}
