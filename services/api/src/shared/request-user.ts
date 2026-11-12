import type { FastifyRequest, onRequestHookHandler } from 'fastify';
import type { Address } from 'viem';
import { AppError } from './errors.js';

export interface AuthenticatedUser {
  userId: string;
  /** Lowercase wallet address the user signed in with. */
  walletAddress: Address;
}

declare module 'fastify' {
  interface FastifyRequest {
    /** Set by the auth hook when the request carries a valid bearer token. */
    user: AuthenticatedUser | null;
  }
}

/** Anything that turns a bearer token into a user, or throws a 401. */
export interface TokenVerifier {
  verify(token: string): Promise<AuthenticatedUser>;
}

const BEARER = /^Bearer\s+(\S+)$/i;

/**
 * Runs on every request. With no Authorization header the request stays anonymous;
 * a header that's malformed or carries a bad token is rejected with 401.
 */
export function authHook(tokens: TokenVerifier): onRequestHookHandler {
  return async (request) => {
    const header = request.headers.authorization;
    if (header === undefined) return;
    const token = BEARER.exec(header)?.[1];
    if (!token) throw new AppError('invalid_token', 'Authorization header must be "Bearer <token>"', 401);
    request.user = await tokens.verify(token);
  };
}

/** The signed-in user. Protected routes call this first; it throws 401 for anonymous requests. */
export function requireUser(request: FastifyRequest): AuthenticatedUser {
  if (!request.user) {
    throw new AppError('unauthorized', 'Sign in first and send "Authorization: Bearer <token>"', 401);
  }
  return request.user;
}

export function requireUserId(request: FastifyRequest): string {
  return requireUser(request).userId;
}
