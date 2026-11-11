import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { bytes32Schema, hexSchema, minorUnitsSchema } from '../../shared/schemas.js';
import { requireUserId } from '../../shared/request-user.js';
import type { PaymentService } from './service.js';

const SubmitBody = z.object({
  quoteId: bytes32Schema,
  validAfter: minorUnitsSchema,
  validBefore: minorUnitsSchema,
  /** User's EIP-712 signature over USDC ReceiveWithAuthorization. */
  signature: hexSchema,
});

const PaymentParams = z.object({ id: z.string().min(1) });

export const paymentRoutes: FastifyPluginAsync<{ payments: PaymentService }> = async (
  app,
  { payments },
) => {
  app.post('/payments', async (request) => {
    const { quoteId, validAfter, validBefore, signature } = SubmitBody.parse(request.body);
    const userId = requireUserId(request);
    return payments.submit({ userId, quoteId, authorization: { validAfter, validBefore, signature } });
  });

  app.get('/payments/:id', async (request) => {
    const { id } = PaymentParams.parse(request.params);
    return payments.get(requireUserId(request), id);
  });
};
