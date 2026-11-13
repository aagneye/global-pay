import { timingSafeEqual } from 'node:crypto';
import type { FastifyPluginAsyncZod, ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { AppError } from '../../shared/errors.js';
import { OPS_PAGE, OPS_SCRIPT, OPS_STYLE } from './page.js';
import type { OpsService } from './service.js';

const TOKEN_HEADER = 'x-ops-token';

const Params = z.object({ id: z.string().min(1) });
const Actor = z.object({
  actor: z.string().trim().min(2).max(64).meta({ description: 'Who is acting (shown in the audit log)' }),
  note: z.string().trim().min(3).max(500).meta({ description: 'Why' }),
});
const MarkPaid = Actor.extend({
  reference: z.string().trim().min(4).max(64).meta({ description: 'Bank or partner reference proving payment' }),
});

/** JSON with bigints as strings. */
const serialize = (payload: unknown) =>
  JSON.stringify(payload, (_key, value) => (typeof value === 'bigint' ? value.toString() : value));

/**
 * The operator console: /ops (a page) and /ops/api/* (JSON). Off (404) unless OPS_API_TOKEN is set.
 * The API needs the token in the X-Ops-Token header, compared in constant time; it's separate from user
 * sign-in, so a user token can never reach it. Hidden from the app's OpenAPI spec.
 */
export const opsRoutes: FastifyPluginAsyncZod<{ ops: OpsService; token: string | undefined }> = async (
  app,
  { ops, token },
) => {
  if (!token) return;
  const expected = Buffer.from(token);

  const security = {
    'content-security-policy': "default-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
    'x-frame-options': 'DENY',
    'referrer-policy': 'no-referrer',
    'cache-control': 'no-store',
  };
  app.get('/ops', { schema: { hide: true } }, (_request, reply) =>
    reply.headers(security).type('text/html; charset=utf-8').send(OPS_PAGE),
  );
  app.get('/ops/ops.js', { schema: { hide: true } }, (_request, reply) =>
    reply.headers(security).type('text/javascript; charset=utf-8').send(OPS_SCRIPT),
  );
  app.get('/ops/ops.css', { schema: { hide: true } }, (_request, reply) =>
    reply.headers(security).type('text/css; charset=utf-8').send(OPS_STYLE),
  );

  await app.register(async (scope) => {
    const api = scope.withTypeProvider<ZodTypeProvider>();
    api.setReplySerializer(serialize);
    api.addHook('onRequest', async (request, reply) => {
      const given = request.headers[TOKEN_HEADER];
      const actual = Buffer.from(typeof given === 'string' ? given : '');
      if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
        throw new AppError('unauthorized', `Send the operator token in the ${TOKEN_HEADER} header`, 401);
      }
      reply.header('cache-control', 'no-store');
    });

    const hide = { hide: true } as const;
    api.get('/ops/api/health', { schema: hide }, () => ops.health());
    api.get('/ops/api/exceptions', { schema: hide }, async () => ({ items: await ops.exceptions() }));
    api.get('/ops/api/actions', { schema: hide }, async () => ({ items: await ops.actions(100) }));
    api.get('/ops/api/payouts/:id', { schema: { ...hide, params: Params } }, (request) => ops.payout(request.params.id));

    api.post('/ops/api/payouts/:id/recheck', { schema: { ...hide, params: Params, body: Actor } }, async (request) => {
      const payout = await ops.recheck(request.params.id, request.body);
      request.log.warn({ paymentId: request.params.id, actor: request.body.actor }, 'ops: recheck');
      return { payout };
    });
    api.post('/ops/api/payouts/:id/mark-paid', { schema: { ...hide, params: Params, body: MarkPaid } }, async (request) => {
      const payout = await ops.markPaid(request.params.id, request.body);
      request.log.warn({ paymentId: request.params.id, actor: request.body.actor }, 'ops: payout marked paid');
      return { payout };
    });
    api.post(
      '/ops/api/payouts/:id/approve-refund',
      { schema: { ...hide, params: Params, body: Actor } },
      async (request) => {
        const payout = await ops.approveRefund(request.params.id, request.body);
        request.log.warn({ paymentId: request.params.id, actor: request.body.actor }, 'ops: refund approved');
        return { payout };
      },
    );
  });
};
