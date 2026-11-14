import fastifyRateLimit, { normalizeIP } from '@fastify/rate-limit';
import type { FastifyInstance, FastifyRequest, preHandlerAsyncHookHandler } from 'fastify';
import { AppError } from './errors.js';

/** Requests allowed per window, from the RATE_LIMIT_* settings. */
export interface RateLimitSettings {
  windowMs: number;
  /** Any route without its own limit, per IP. */
  global: number;
  auth: number;
  payments: number;
  onramp: number;
  p2p: number;
  devices: number;
  webhooks: number;
  ops: number;
}

type Budget = Exclude<keyof RateLimitSettings, 'windowMs'>;

interface Policy {
  budget: Budget;
  /** `user`: the signed-in user, or the IP for anonymous requests (which the route then rejects). */
  per: 'ip' | 'user';
}

/**
 * Routes with their own limit, by method and route pattern. Each has its own counter.
 * Every other route shares the global budget, per IP. /health is never limited (load balancer probes).
 */
const ROUTE_POLICIES: ReadonlyMap<string, Policy> = new Map<string, Policy>([
  ['POST /auth/nonce', { budget: 'auth', per: 'ip' }],
  ['POST /auth/verify', { budget: 'auth', per: 'ip' }],
  ['POST /quotes', { budget: 'payments', per: 'user' }],
  ['POST /payments', { budget: 'payments', per: 'user' }],
  ['POST /onramp/orders', { budget: 'onramp', per: 'user' }],
  ['POST /devices', { budget: 'devices', per: 'user' }],
  ['POST /p2p/requests', { budget: 'p2p', per: 'user' }],
  ['POST /p2p/requests/:id/tap', { budget: 'p2p', per: 'user' }],
  ['POST /p2p/requests/:id/claim', { budget: 'p2p', per: 'user' }],
  ['POST /p2p/requests/:id/approve', { budget: 'p2p', per: 'user' }],
  ['POST /webhooks/payouts/:partner', { budget: 'webhooks', per: 'ip' }],
  ['POST /webhooks/onramp/:partner', { budget: 'webhooks', per: 'ip' }],
]);
const OPS_API: Policy = { budget: 'ops', per: 'ip' };
const GLOBAL: Policy = { budget: 'global', per: 'ip' };
const UNLIMITED = new Set(['/health']);

/** The policy for a request, and the counter it uses. */
function classify(request: FastifyRequest): { policy: Policy; counter: string } {
  const url = request.routeOptions.url;
  const route = `${request.method} ${url}`;
  const policy = ROUTE_POLICIES.get(route);
  if (policy) return { policy, counter: route };
  if (url?.startsWith('/ops/api/')) return { policy: OPS_API, counter: 'ops' };
  return { policy: GLOBAL, counter: 'global' };
}

/**
 * Registers @fastify/rate-limit for every route; call it before declaring routes.
 * It runs after the auth hook (route hooks follow app hooks), so per-user limits can see the user. (So a bad
 * bearer token gets its 401 before any limit; that costs one HMAC and reaches nothing else.) A 429 uses the API's error shape, `{ "error": "rate_limited" }`, with Retry-After.
 * Counters are in memory, per process: behind several instances, each one counts on its own.
 * Returns the limiter as a hook for the not-found handler, so scanning unknown URLs counts too.
 */
export async function registerRateLimits(
  app: FastifyInstance,
  settings: RateLimitSettings,
): Promise<preHandlerAsyncHookHandler> {
  await app.register(fastifyRateLimit, {
    global: true,
    timeWindow: settings.windowMs,
    cache: 10_000,
    allowList: (request) => UNLIMITED.has(request.routeOptions.url ?? ''),
    max: (request) => settings[classify(request).policy.budget],
    keyGenerator: (request) => {
      const { policy, counter } = classify(request);
      const subject = policy.per === 'user' && request.user ? `user:${request.user.userId}` : `ip:${normalizeIP(request.ip)}`;
      return `${counter}|${subject}`;
    },
    onExceeded: (request) => {
      request.log.warn({ limit: classify(request).counter }, 'rate limited');
    },
    errorResponseBuilder: (_request, context) =>
      new AppError('rate_limited', `Too many requests. Try again in ${context.after}.`, context.statusCode),
  });
  return app.rateLimit();
}
