import type { FastifyRequest } from 'fastify';
import { NotImplementedError } from './errors.js';

/**
 * Returns the authenticated user's ID from the request's JWT (issued after
 * Sign-In with Ethereum). Protected routes call this first.
 */
export function requireUserId(_request: FastifyRequest): string {
  throw new NotImplementedError('JWT auth hook', 3);
}
