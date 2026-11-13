import fastifySwagger from '@fastify/swagger';
import fastifySwaggerUi from '@fastify/swagger-ui';
import Fastify, { type FastifyInstance } from 'fastify';
import {
  type ZodTypeProvider,
  hasZodFastifySchemaValidationErrors,
  isResponseSerializationError,
  jsonSchemaTransform,
  serializerCompiler,
  validatorCompiler,
} from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { Container } from './container.js';
import { accountRoutes } from './modules/account/routes.js';
import { authRoutes } from './modules/auth/routes.js';
import { kycRoutes } from './modules/kyc/routes.js';
import { paymentRoutes } from './modules/payments/routes.js';
import { payoutWebhookRoutes } from './modules/payouts/webhook-routes.js';
import { quoteRoutes } from './modules/quotes/routes.js';
import { AppError } from './shared/errors.js';
import { namedSchemasTransform } from './shared/openapi.js';
import { authHook } from './shared/request-user.js';

export interface BuildAppOptions {
  container: Container;
  logger?: boolean;
}

export async function buildApp({ container, logger = true }: BuildAppOptions): Promise<FastifyInstance> {
  const app = Fastify({ logger }).withTypeProvider<ZodTypeProvider>();

  // Route schemas are zod: they validate requests, shape responses, and generate the OpenAPI spec.
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  app.decorateRequest('user', null);
  app.addHook('onRequest', authHook(container.tokens));

  app.setErrorHandler((error, request, reply) => {
    if (hasZodFastifySchemaValidationErrors(error)) {
      return reply.code(400).send({
        error: 'invalid_request',
        message: error.message,
        issues: error.validation.map((issue) => ({ path: issue.instancePath, message: issue.message })),
      });
    }
    if (error instanceof z.ZodError) {
      return reply.code(400).send({ error: 'invalid_request', issues: error.issues });
    }
    if (error instanceof AppError) {
      return reply.code(error.statusCode).send({ error: error.code, message: error.message });
    }
    if (isResponseSerializationError(error)) {
      request.log.error({ err: error, cause: error.cause }, 'response did not match its schema');
      return reply.code(500).send({ error: 'internal_error', message: 'Something went wrong' });
    }
    const statusCode = (error as { statusCode?: unknown }).statusCode;
    if (typeof statusCode === 'number' && statusCode >= 400 && statusCode < 500) {
      return reply.code(statusCode).send({ error: 'bad_request', message: (error as Error).message });
    }
    request.log.error(error);
    return reply.code(500).send({ error: 'internal_error', message: 'Something went wrong' });
  });

  await app.register(fastifySwagger, {
    openapi: {
      openapi: '3.0.3',
      info: {
        title: 'GlobalPay API',
        version: '0.1.0',
        description:
          'Pay Thai PromptPay QRs with USDC on Base. Testnet demo: partners are simulated.\n\n' +
          'Money is sent as integer strings in minor units: THB satang ("10000" = 100.00 THB) and ' +
          'USDC base units ("1000000" = 1 USDC). Rates are THB per USDC × 1e8.',
      },
      tags: [
        { name: 'auth', description: 'Sign-In with Ethereum' },
        { name: 'kyc', description: 'Identity verification (mock) and limits' },
        { name: 'quotes', description: 'Signed quotes for PromptPay QRs' },
        { name: 'payments', description: 'Submit and track payments (iteration 4)' },
        { name: 'account', description: 'Balance and history (iteration 4)' },
        { name: 'system' },
      ],
      components: {
        securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' } },
      },
    },
    transform: jsonSchemaTransform,
    transformObject: namedSchemasTransform,
  });
  await app.register(fastifySwaggerUi, { routePrefix: '/docs' });

  app.get(
    '/health',
    {
      schema: {
        tags: ['system'],
        operationId: 'getHealth',
        response: { 200: z.object({ status: z.literal('ok') }).meta({ id: 'Health' }) },
      },
    },
    async () => ({ status: 'ok' as const }),
  );

  const { services } = container;
  await app.register(authRoutes, { auth: services.auth });
  await app.register(kycRoutes, { kyc: services.kyc });
  await app.register(quoteRoutes, { quotes: services.quotes });
  await app.register(paymentRoutes, { payments: services.payments });
  await app.register(accountRoutes, { account: services.account });
  await app.register(payoutWebhookRoutes, { tracker: services.payouts });

  return app;
}
