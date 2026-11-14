import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { errorResponses, nearPublicKeySchema, out, walletSchema } from '../../shared/schemas.js';
import type { AuthService } from './service.js';

const NonceBody = z
  .object({
    address: walletSchema.meta({
      description: 'Wallet that will sign in: a 0x address (EVM rail) or a NEAR implicit account (NEAR rail)',
    }),
  })
  .meta({ id: 'NonceRequest' });
const NonceResponse = z.object({
  nonce: z.string().meta({ description: 'EVM rail: the SIWE nonce. NEAR rail: the NEP-413 nonce, 32 bytes as hex' }),
  message: z.string().meta({
    description:
      'EVM rail: EIP-4361 message to sign with personal_sign, unchanged. ' +
      'NEAR rail: the NEP-413 `message` to sign, unchanged, with this nonce and recipient = the sign-in domain',
  }),
  expiresAt: out.dateTime,
}).meta({ id: 'NonceResponse' });

const VerifyBody = z.object({
  message: z.string().min(1).max(2_000),
  signature: z.string().min(1).max(1_000).meta({
    description:
      'EVM rail: personal_sign signature over `message` (0x hex). NEAR rail: the NEP-413 ed25519 signature (base64, 64 bytes)',
  }),
  publicKey: nearPublicKeySchema
    .optional()
    .meta({ description: 'NEAR rail (required there): the key that signed, "ed25519:" + base58' }),
}).meta({ id: 'SignInRequest' });
const VerifyResponse = z.object({
  token: z.string(),
  tokenType: z.literal('Bearer'),
  expiresAt: out.dateTime,
  user: z
    .object({
      id: z.string(),
      walletAddress: z.string().meta({ description: '0x address (EVM rail) or NEAR implicit account (NEAR rail)' }),
    })
    .meta({ id: 'User' }),
}).meta({ id: 'SignInResponse' });

export const authRoutes: FastifyPluginAsyncZod<{ auth: AuthService }> = async (app, { auth }) => {
  app.post(
    '/auth/nonce',
    {
      schema: {
        tags: ['auth'],
        summary: 'Start sign-in: get a one-time nonce and the message to sign',
        operationId: 'createSignInNonce',
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
        operationId: 'verifySignIn',
        body: VerifyBody,
        response: { 200: VerifyResponse, 400: errorResponses[400], 401: errorResponses[401] },
      },
    },
    async (request) => {
      const { message, signature, publicKey } = request.body;
      const { token, expiresAt, user } = await auth.verify(message, signature, publicKey);
      return { token, tokenType: 'Bearer' as const, expiresAt: expiresAt.toISOString(), user };
    },
  );
};
