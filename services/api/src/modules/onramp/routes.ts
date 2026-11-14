import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { bearerAuth, errorResponses, minorUnitsSchema, out } from '../../shared/schemas.js';
import { requireUserId } from '../../shared/request-user.js';
import type { OnrampService } from './service.js';

export const OnrampOrderDto = z
  .object({
    id: z.string(),
    status: z.enum(['CREATED', 'PENDING', 'COMPLETED', 'FAILED', 'EXPIRED']).meta({
      description:
        'CREATED: waiting for you to pay. PENDING: paid, USDC on its way. COMPLETED: USDC arrived in your wallet ' +
        '(checked on-chain). FAILED: the purchase failed. EXPIRED: not paid in time.',
    }),
    provider: z.string(),
    fiatCurrency: z.string(),
    fiatAmount: out.uint.meta({ description: 'THB satang you pay' }),
    tokenAmount: out.uint.optional().meta({ description: 'USDC base units: received, or promised by the partner' }),
    transaction: z.object({ hash: out.bytes32, url: z.string() }).optional().meta({ id: 'OnrampTransaction' }),
    failureReason: z.string().optional(),
    expiresAt: out.dateTime,
    createdAt: out.dateTime,
    updatedAt: out.dateTime,
  })
  .meta({ id: 'OnrampOrder' });

const OrderParams = z.object({ id: z.string().min(1) });

export const onrampRoutes: FastifyPluginAsyncZod<{ onramp: OnrampService }> = async (app, { onramp }) => {
  app.post(
    '/onramp/orders',
    {
      schema: {
        tags: ['onramp'],
        summary: 'Add money: start buying USDC with baht',
        operationId: 'createOnrampOrder',
        description:
          "Returns the partner's checkout page to open in the browser (a Custom Tab). The USDC goes to the " +
          "signed-in user's wallet. Poll GET /onramp/orders/{id} until COMPLETED, FAILED or EXPIRED. " +
          'checkoutUrl may be relative to the API (the local simulator).',
        security: bearerAuth,
        body: z
          .object({ fiatAmountMinor: minorUnitsSchema.meta({ description: 'THB satang, e.g. "80000" = 800.00 THB' }) })
          .meta({ id: 'OnrampOrderRequest' }),
        response: {
          201: z.object({ order: OnrampOrderDto, checkoutUrl: z.string() }).meta({ id: 'OnrampCheckout' }),
          400: errorResponses[400],
          401: errorResponses[401],
          422: errorResponses[422],
          429: errorResponses[429],
          503: errorResponses[503],
        },
      },
    },
    async (request, reply) => reply.code(201).send(await onramp.create(requireUserId(request), request.body.fiatAmountMinor)),
  );

  app.get(
    '/onramp/orders',
    {
      schema: {
        tags: ['onramp'],
        summary: 'Your Add-money orders, newest first (last 20)',
        operationId: 'listOnrampOrders',
        security: bearerAuth,
        response: { 200: z.object({ orders: z.array(OnrampOrderDto) }).meta({ id: 'OnrampOrderList' }), 401: errorResponses[401] },
      },
    },
    async (request) => ({ orders: await onramp.list(requireUserId(request)) }),
  );

  app.get(
    '/onramp/orders/:id',
    {
      schema: {
        tags: ['onramp'],
        summary: 'An Add-money order, checked with the partner if due',
        operationId: 'getOnrampOrder',
        security: bearerAuth,
        params: OrderParams,
        response: { 200: OnrampOrderDto, 401: errorResponses[401], 404: errorResponses[404] },
      },
    },
    async (request) => onramp.get(requireUserId(request), request.params.id),
  );
};
