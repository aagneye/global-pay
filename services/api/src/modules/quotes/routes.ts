import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { addressSchema, minorUnitsSchema } from '../../shared/schemas.js';
import { requireUserId } from '../../shared/request-user.js';
import type { QuoteService } from './service.js';

const QuoteBody = z.object({
  /** Wallet that will pay; must match the signed-in user's wallet. */
  payer: addressSchema,
  qrPayload: z.string().min(20).max(512),
  /** THB satang. Required when the QR has no amount. */
  fiatAmountMinor: minorUnitsSchema.optional(),
});

export const quoteRoutes: FastifyPluginAsync<{ quotes: QuoteService }> = async (app, { quotes }) => {
  app.post('/quotes', async (request) => {
    const body = QuoteBody.parse(request.body);
    const userId = requireUserId(request);
    return quotes.createQuote({ userId, ...body });
  });
};
