import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { AppError } from '../../shared/errors.js';
import type { PayoutTracker } from './payout-tracker.js';

/**
 * POST /webhooks/payouts/:partner — status updates from the payout partner (e.g. Xendit).
 *
 * A webhook is only a hint: its token is checked, it's stored as an event, and then the payout is
 * fetched from the partner before anything changes. A 200 means "received", even when the payout is
 * unknown to us, so the partner stops retrying. A 5xx (our database down) makes it retry later.
 * Not part of the app's API, so hidden from the OpenAPI spec.
 */
export const payoutWebhookRoutes: FastifyPluginAsyncZod<{ tracker: PayoutTracker }> = async (app, { tracker }) => {
  app.post(
    '/webhooks/payouts/:partner',
    {
      schema: { hide: true, params: z.object({ partner: z.string() }), body: z.unknown() },
    },
    async (request, reply) => {
      if (request.params.partner !== tracker.providerName) {
        throw new AppError('not_found', 'No such webhook', 404);
      }
      const ref = tracker.parseWebhook(request.headers, request.body);
      if (ref === undefined) throw new AppError('not_found', 'No such webhook', 404);
      if (ref === null) throw new AppError('unauthorized', 'Invalid webhook token', 401);

      const outcome = await tracker.onWebhook(ref, request.body);
      request.log.info({ ...ref, outcome }, 'payout webhook');
      return reply.code(200).send({ received: true });
    },
  );
};
