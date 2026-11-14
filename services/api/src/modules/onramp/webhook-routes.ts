import type { FastifyPluginAsync } from 'fastify';
import { AppError } from '../../shared/errors.js';
import type { OnrampService } from './service.js';

/**
 * POST /webhooks/onramp/:partner — purchase updates from the onramp partner (MoonPay).
 *
 * The signature covers the exact bytes sent, so this plugin keeps JSON bodies as raw strings (only for
 * its own routes). A webhook is only a hint: once its signature and age are checked, the order is
 * fetched from the partner again. 200 means "received", even for an order we don't know.
 * Not part of the app's API, so hidden from the OpenAPI spec.
 */
export const onrampWebhookRoutes: FastifyPluginAsync<{ onramp: OnrampService }> = async (app, { onramp }) => {
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (_request, body, done) => done(null, body));

  app.post<{ Params: { partner: string }; Body: string }>(
    '/webhooks/onramp/:partner',
    { schema: { hide: true } },
    async (request, reply) => {
      const { provider, tracker } = onramp;
      if (request.params.partner !== provider.name || !provider.parseWebhook) {
        throw new AppError('not_found', 'No such webhook', 404);
      }
      const raw = typeof request.body === 'string' ? request.body : '';
      const ref = provider.parseWebhook(request.headers, raw, new Date());
      if (!ref) throw new AppError('unauthorized', 'Invalid webhook signature', 401);

      const outcome = await tracker.onWebhook(ref);
      request.log.info({ ...ref, outcome }, 'onramp webhook');
      return reply.code(200).send({ received: true });
    },
  );
};
