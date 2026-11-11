import type { FastifyPluginAsync } from 'fastify';
import { requireUserId } from '../../shared/request-user.js';
import type { AccountService } from './service.js';

export const accountRoutes: FastifyPluginAsync<{ account: AccountService }> = async (
  app,
  { account },
) => {
  app.get('/me/balance', async (request) => account.balance(requireUserId(request)));

  app.get('/me/payments', async (request) => account.payments(requireUserId(request)));
};
