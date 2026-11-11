import Fastify, { type FastifyInstance } from 'fastify';
import { ZodError } from 'zod';
import type { Container } from './container.js';
import { accountRoutes } from './modules/account/routes.js';
import { authRoutes } from './modules/auth/routes.js';
import { kycRoutes } from './modules/kyc/routes.js';
import { paymentRoutes } from './modules/payments/routes.js';
import { quoteRoutes } from './modules/quotes/routes.js';
import { AppError } from './shared/errors.js';

export interface BuildAppOptions {
  container: Container;
  logger?: boolean;
}

export async function buildApp({ container, logger = true }: BuildAppOptions): Promise<FastifyInstance> {
  const app = Fastify({ logger });

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof ZodError) {
      return reply.code(400).send({ error: 'invalid_request', issues: error.issues });
    }
    if (error instanceof AppError) {
      return reply.code(error.statusCode).send({ error: error.code, message: error.message });
    }
    const statusCode = (error as { statusCode?: unknown }).statusCode;
    if (typeof statusCode === 'number' && statusCode >= 400 && statusCode < 500) {
      return reply.code(statusCode).send({ error: 'bad_request', message: (error as Error).message });
    }
    request.log.error(error);
    return reply.code(500).send({ error: 'internal_error', message: 'Something went wrong' });
  });

  app.get('/health', async () => ({ status: 'ok' }));

  const { services } = container;
  await app.register(authRoutes, { auth: services.auth });
  await app.register(kycRoutes, { kyc: services.kyc });
  await app.register(quoteRoutes, { quotes: services.quotes });
  await app.register(paymentRoutes, { payments: services.payments });
  await app.register(accountRoutes, { account: services.account });

  return app;
}
