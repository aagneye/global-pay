import type { FastifyPluginAsync } from 'fastify';
import { requireUserId } from '../../shared/request-user.js';
import type { KycService } from './service.js';

export const kycRoutes: FastifyPluginAsync<{ kyc: KycService }> = async (app, { kyc }) => {
  app.post('/kyc/start', async (request) => kyc.start(requireUserId(request)));

  app.get('/kyc/status', async (request) => kyc.status(requireUserId(request)));
};
