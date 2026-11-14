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
import { onrampRoutes } from './modules/onramp/routes.js';
import { onrampSimulatorRoutes } from './modules/onramp/simulator-routes.js';
import { onrampWebhookRoutes } from './modules/onramp/webhook-routes.js';
import { opsRoutes } from './modules/ops/routes.js';
import { p2pRoutes } from './modules/p2p/routes.js';
import { paymentRoutes } from './modules/payments/routes.js';
import { payoutWebhookRoutes } from './modules/payouts/webhook-routes.js';
import { quoteRoutes } from './modules/quotes/routes.js';
import { AppError } from './shared/errors.js';
import { namedSchemasTransform } from './shared/openapi.js';
import { type LogDestination, loggerOptions } from './shared/logging.js';
import { registerRateLimits } from './shared/rate-limits.js';
import { authHook } from './shared/request-user.js';
import { securityHeaders } from './shared/security-headers.js';

export interface BuildAppOptions {
  container: Container;
  /** false: no logs. Secrets and personal data are kept out of whatever is logged. */
  logger?: boolean | LogDestination;
}

export async function buildApp({ container, logger = true }: BuildAppOptions): Promise<FastifyInstance> {
  const { http } = container;
  const hops = http.trustProxy;
  const trustProxy = typeof hops === 'number' ? (_address: string, hop: number) => hop < hops : hops;
  const app = Fastify({ logger: loggerOptions(logger), trustProxy, bodyLimit: http.bodyLimit }).withTypeProvider<ZodTypeProvider>();

  // Route schemas are zod: they validate requests, shape responses, and generate the OpenAPI spec.
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  app.decorateRequest('user', null);
  app.addHook('onRequest', authHook(container.tokens));
  app.addHook('onSend', securityHeaders);

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
      request.log.error({ err: error }, 'response did not match its schema');
      return reply.code(500).send({ error: 'internal_error', message: 'Something went wrong' });
    }
    const statusCode = (error as { statusCode?: unknown }).statusCode;
    if (typeof statusCode === 'number' && statusCode >= 400 && statusCode < 500) {
      const code = statusCode === 413 ? 'payload_too_large' : 'bad_request';
      return reply.code(statusCode).send({ error: code, message: (error as Error).message });
    }
    request.log.error({ err: error }, 'request failed');
    return reply.code(500).send({ error: 'internal_error', message: 'Something went wrong' });
  });

  // Before any route, so every route gets its limit.
  const rateLimited = http.rateLimits ? await registerRateLimits(app, http.rateLimits) : undefined;
  app.setNotFoundHandler(rateLimited ? { preHandler: rateLimited } : {}, (request, reply) =>
    reply.code(404).send({ error: 'not_found', message: `Route ${request.method} ${request.url.split('?')[0]} not found` }),
  );

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
        { name: 'account', description: 'Balance, payments and deposits' },
        { name: 'onramp', description: 'Add money: buy USDC with baht (iteration 8)' },
        { name: 'p2p', description: 'Tap to pay: person-to-person USDC requests (iteration 9)' },
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
  await app.register(opsRoutes, { ops: services.ops, token: container.opsToken });
  await app.register(onrampRoutes, { onramp: services.onramp });
  await app.register(p2pRoutes, { p2p: services.p2p });
  await app.register(onrampWebhookRoutes, { onramp: services.onramp });
  await app.register(onrampSimulatorRoutes, { onramp: services.onramp });

  return app;
}
