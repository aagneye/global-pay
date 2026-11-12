import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { addressSchema, errorResponses, hexSchema, out } from '../../shared/schemas.js';
import type { AuthService } from './service.js';

const NonceBody = z.object({ address: addressSchema.meta({ description: 'Wallet that will sign in' }) });
const NonceResponse = z.object({
  nonce: z.string(),
  message: z.string().meta({ description: 'EIP-4361 message to sign with personal_sign, unchanged' }),
  expiresAt: out.dateTime,
});

const VerifyBody = z.object({
  message: z.string().min(1).max(2_000),
  signature: hexSchema.meta({ description: 'personal_sign signature over `message`' }),
});
const VerifyResponse = z.object({
  token: z.string(),
  tokenType: z.literal('Bearer'),
  expiresAt: out.dateTime,
  user: z.object({ id: z.string(), walletAddress: out.address }),
});

export const authRoutes: FastifyPluginAsyncZod<{ auth: AuthService }> = async (app, { auth }) => {
  app.post(
    '/auth/nonce',
    {
      schema: {
        tags: ['auth'],
        summary: 'Start sign-in: get a one-time nonce and the message to sign',
        body: NonceBody,
        response: { 200: NonceResponse, 400: errorResponses[400] },
      },
    },
    async (request) => {
      const { nonce, message, expiresAt } = await auth.createNonce(request.body.address);
      return { nonce, message, expiresAt: expiresAt.toISOString() };
    },
  );

  app.post(
    '/auth/verify',
    {
      schema: {
        tags: ['auth'],
        summary: 'Finish sign-in: verify the signed message and get an access token',
        body: VerifyBody,
        response: { 200: VerifyResponse, 400: errorResponses[400], 401: errorResponses[401] },
      },
    },
    async (request) => {
      const { token, expiresAt, user } = await auth.verify(request.body.message, request.body.signature);
      return { token, tokenType: 'Bearer' as const, expiresAt: expiresAt.toISOString(), user };
    },
  );
};
