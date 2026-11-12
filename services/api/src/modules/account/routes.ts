import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { bearerAuth } from '../../shared/schemas.js';
import { requireUserId } from '../../shared/request-user.js';
import type { AccountService } from './service.js';

export const accountRoutes: FastifyPluginAsyncZod<{ account: AccountService }> = async (app, { account }) => {
  app.get(
    '/me/balance',
    { schema: { tags: ['account'], summary: 'USDC balance (iteration 4)', security: bearerAuth } },
    async (request) => account.balance(requireUserId(request)),
  );

  app.get(
    '/me/payments',
    { schema: { tags: ['account'], summary: 'Payment history (iteration 4)', security: bearerAuth } },
    async (request) => account.payments(requireUserId(request)),
  );
};
