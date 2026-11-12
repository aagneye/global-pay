import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import {
  bearerAuth,
  bytes32Schema,
  errorResponses,
  hexSchema,
  minorUnitsSchema,
  out,
} from '../../shared/schemas.js';
import { requireUserId } from '../../shared/request-user.js';
import type { PaymentService } from './service.js';

const SubmitBody = z.object({
  quoteId: bytes32Schema,
  validAfter: minorUnitsSchema.meta({ description: 'From authorizationToSign.message, unchanged' }),
  validBefore: minorUnitsSchema.meta({ description: 'From authorizationToSign.message, unchanged' }),
  signature: hexSchema.meta({ description: "The payer wallet's signature over authorizationToSign" }),
}).meta({ id: 'PaymentRequest' });

const PaymentParams = z.object({ id: z.string().min(1) });

const txLink = z.object({ hash: out.bytes32, url: z.string() }).meta({ id: 'TxLink' });

export const PaymentDto = z.object({
  id: z.string(),
  quoteId: out.bytes32,
  status: z
    .enum(['SUBMITTED', 'PAID', 'PAYOUT_PENDING', 'SETTLED', 'REFUNDED', 'FAILED'])
    .meta({ description: 'SETTLED, REFUNDED and FAILED are final. Poll until one of them.' }),
  fiatCurrency: z.string(),
  fiatAmount: out.uint.meta({ description: 'THB satang the merchant receives' }),
  token: out.address,
  tokenAmount: out.uint.meta({ description: 'USDC base units the user pays' }),
  merchant: z
    .object({ kind: z.string(), targetId: z.string(), name: z.string().optional() })
    .meta({ id: 'PaymentMerchant' }),
  transactions: z
    .object({ pay: txLink.optional(), settle: txLink.optional(), refund: txLink.optional() })
    .meta({ id: 'PaymentTransactions' }),
  failureReason: z.string().optional(),
  quoteExpiresAt: out.dateTime,
  createdAt: out.dateTime,
  updatedAt: out.dateTime,
}).meta({ id: 'Payment' });

export const paymentRoutes: FastifyPluginAsyncZod<{ payments: PaymentService }> = async (app, { payments }) => {
  app.post(
    '/payments',
    {
      schema: {
        tags: ['payments'],
        summary: 'Pay a quote with the signed USDC authorisation',
        operationId: 'submitPayment',
        description:
          'Checks the signature and limits, then relays pay() and returns at once with status SUBMITTED. ' +
          'Poll GET /payments/{id} until SETTLED, REFUNDED or FAILED. Submitting the same quote again ' +
          'returns the same payment.',
        security: bearerAuth,
        body: SubmitBody,
        response: {
          202: PaymentDto,
          400: errorResponses[400],
          401: errorResponses[401],
          403: errorResponses[403],
          404: errorResponses[404],
          422: errorResponses[422],
          503: errorResponses[503],
        },
      },
    },
    async (request, reply) => {
      const userId = requireUserId(request);
      const { quoteId, validAfter, validBefore, signature } = request.body;
      const payment = await payments.submit({ userId, quoteId, authorization: { validAfter, validBefore, signature } });
      return reply.code(202).send(payment);
    },
  );

  app.get(
    '/payments/:id',
    {
      schema: {
        tags: ['payments'],
        summary: 'Payment status and transactions',
        operationId: 'getPayment',
        security: bearerAuth,
        params: PaymentParams,
        response: { 200: PaymentDto, 401: errorResponses[401], 404: errorResponses[404] },
      },
    },
    async (request) => payments.get(requireUserId(request), request.params.id),
  );
};
