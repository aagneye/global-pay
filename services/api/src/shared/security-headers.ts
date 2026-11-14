import type { onSendAsyncHookHandler } from 'fastify';

/**
 * Basic security headers on every response. A route's own value wins (the /ops page sets a stricter set).
 * - all: no MIME sniffing, no Referer to other sites, no framing;
 * - JSON (the API): a CSP that allows nothing, and no caching, since responses carry balances and payments.
 *   HTML pages (/docs, /ops, the onramp simulator) keep their own CSP, so Swagger UI still loads.
 * HSTS belongs to whatever terminates TLS in front of the API.
 */
export const securityHeaders: onSendAsyncHookHandler = async (_request, reply, payload) => {
  reply.header('x-content-type-options', 'nosniff');
  if (!reply.hasHeader('referrer-policy')) reply.header('referrer-policy', 'no-referrer');
  if (!reply.hasHeader('x-frame-options')) reply.header('x-frame-options', 'DENY');
  if (String(reply.getHeader('content-type') ?? '').startsWith('application/json')) {
    if (!reply.hasHeader('content-security-policy')) reply.header('content-security-policy', "default-src 'none'; frame-ancestors 'none'");
    if (!reply.hasHeader('cache-control')) reply.header('cache-control', 'no-store');
  }
  return payload;
};
