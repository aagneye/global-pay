import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { addressSchema, hexSchema } from '../../shared/schemas.js';
import type { AuthService } from './service.js';

const NonceBody = z.object({ address: addressSchema });
const VerifyBody = z.object({ message: z.string().min(1), signature: hexSchema });

export const authRoutes: FastifyPluginAsync<{ auth: AuthService }> = async (app, { auth }) => {
  app.post('/auth/nonce', async (request) => {
    const { address } = NonceBody.parse(request.body);
    return auth.createNonce(address);
  });

  app.post('/auth/verify', async (request) => {
    const { message, signature } = VerifyBody.parse(request.body);
    return auth.verify(message, signature);
  });
};
