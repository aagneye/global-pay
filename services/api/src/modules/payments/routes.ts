import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import {
  base64Schema,
  bearerAuth,
  bytes32Schema,
  errorResponses,
  hexSchema,
  minorUnitsSchema,
  out,
} from '../../shared/schemas.js';
import { requireUserId } from '../../shared/request-user.js';
import { PAYOUT_STATUSES } from '../../domain/payment.js';
import type { PaymentAuthorization } from '../../domain/quote.js';
import { AppError } from '../../shared/errors.js';
import type { PaymentService } from './service.js';

const SubmitBody = z.object({
  quoteId: bytes32Schema,
  validAfter: minorUnitsSchema
    .optional()
    .meta({ description: 'EVM rail (required there): from authorizationToSign.message, unchanged' }),
  validBefore: minorUnitsSchema
    .optional()
    .meta({ description: 'EVM rail (required there): from authorizationToSign.message, unchanged' }),
  signature: hexSchema
    .optional()
    .meta({ description: "EVM rail (required there): the payer wallet's signature over authorizationToSign" }),
  signedDelegate: base64Schema
    .max(8_192)
    .optional()
    .meta({ description: 'NEAR rail (required there): base64 of the borsh SignedDelegate (NEP-366) for nearPayment' }),
}).meta({ id: 'PaymentRequest' });

const PaymentParams = z.object({ id: z.string().min(1) });

const txLink = z
  .object({ hash: z.string().meta({ description: '0x hash (EVM rail) or base58 hash (NEAR rail)' }), url: z.string() })
  .meta({ id: 'TxLink' });

/** The rail's signed authorisation from the body: a NEAR signed delegate, or EIP-3009 fields. */
function authorizationFrom(body: z.infer<typeof SubmitBody>): PaymentAuthorization {
  const { validAfter, validBefore, signature, signedDelegate } = body;
  if (signedDelegate !== undefined) return { kind: 'near-delegate', signedDelegate };
  if (validAfter === undefined || validBefore === undefined || signature === undefined) {
    throw new AppError(
      'invalid_request',
      'Send validAfter, validBefore and signature (EVM rail), or signedDelegate (NEAR rail)',
      400,
    );
  }
  return { kind: 'eip3009', validAfter, validBefore, signature };
}

export const PaymentDto = z.object({
  id: z.string(),
  quoteId: out.bytes32,
  status: z
    .enum(['SUBMITTED', 'PAID', 'PAYOUT_PENDING', 'SETTLED', 'REFUNDED', 'FAILED'])
    .meta({ description: 'SETTLED, REFUNDED and FAILED are final. Poll until one of them.' }),
  fiatCurrency: z.string(),
  fiatAmount: out.uint.meta({ description: 'THB satang the merchant receives' }),
  token: z.string().meta({ description: 'USDC: its 0x address (EVM rail) or contract account ID (NEAR rail)' }),
  tokenAmount: out.uint.meta({ description: 'USDC base units the user pays' }),
  merchant: z
    .object({ kind: z.string(), targetId: z.string(), name: z.string().optional() })
    .meta({ id: 'PaymentMerchant' }),
  transactions: z
    .object({ pay: txLink.optional(), settle: txLink.optional(), refund: txLink.optional() })
    .meta({ id: 'PaymentTransactions' }),
  payout: z
    .object({
      status: z.enum(PAYOUT_STATUSES).meta({
        description:
          'PENDING: being paid. SUCCEEDED: the merchant was paid (see reference). FAILED: not paid; the user is refunded. ' +
          'UNKNOWN: unclear, being checked; never settled or refunded until it is clear. REVERSED: paid, then undone.',
      }),
      provider: z.string(),
      reference: z.string().optional().meta({ description: 'Bank or partner reference, once paid' }),
    })
    .optional()
    .meta({ id: 'PaymentPayout', description: 'Paying the merchant in THB. Absent until the payment is paid on-chain.' }),
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
          'Checks the signature and limits, then relays the payment and returns at once with status SUBMITTED. ' +
          'EVM rail: send validAfter, validBefore and signature (relays pay()). NEAR rail: send signedDelegate ' +
          '(relays the meta transaction). Poll GET /payments/{id} until SETTLED, REFUNDED or FAILED. ' +
          'Submitting the same quote again returns the same payment.',
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
      const payment = await payments.submit({
        userId,
        quoteId: request.body.quoteId,
        authorization: authorizationFrom(request.body),
      });
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
