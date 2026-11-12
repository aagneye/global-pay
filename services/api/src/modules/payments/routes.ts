import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { bearerAuth, bytes32Schema, hexSchema, minorUnitsSchema } from '../../shared/schemas.js';
import { requireUserId } from '../../shared/request-user.js';
import type { PaymentService } from './service.js';

const SubmitBody = z.object({
  quoteId: bytes32Schema,
  validAfter: minorUnitsSchema,
  validBefore: minorUnitsSchema,
  signature: hexSchema.meta({ description: "User's EIP-712 signature over USDC ReceiveWithAuthorization" }),
});

const PaymentParams = z.object({ id: z.string().min(1) });

export const paymentRoutes: FastifyPluginAsyncZod<{ payments: PaymentService }> = async (app, { payments }) => {
  app.post(
    '/payments',
    {
      schema: {
        tags: ['payments'],
        summary: 'Submit the signed USDC authorisation for a quote (iteration 4)',
        security: bearerAuth,
        body: SubmitBody,
      },
    },
    async (request) => {
      const userId = requireUserId(request);
      const { quoteId, validAfter, validBefore, signature } = request.body;
      return payments.submit({ userId, quoteId, authorization: { validAfter, validBefore, signature } });
    },
  );

  app.get(
    '/payments/:id',
    {
      schema: {
        tags: ['payments'],
        summary: 'Payment status (iteration 4)',
        security: bearerAuth,
        params: PaymentParams,
      },
    },
    async (request) => payments.get(requireUserId(request), request.params.id),
  );
};
