import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { bearerAuth, errorResponses, out } from '../../shared/schemas.js';
import { requireUserId } from '../../shared/request-user.js';
import type { KycService, KycView } from './service.js';

const KycStatusResponse = z.object({
  status: z.enum(['NOT_STARTED', 'PENDING', 'APPROVED', 'REJECTED']),
  tier: z.number().int().min(0).max(2).meta({ description: '0 until verification is approved' }),
  limits: z
    .object({
      perPayment: out.uint.meta({ description: 'THB satang' }),
      perDay: out.uint.meta({ description: 'THB satang, rolling 24 hours' }),
    })
    .meta({ id: 'SpendingLimits' }),
}).meta({ id: 'KycStatus' });

const KycStartResponse = KycStatusResponse.extend({
  session: z
    .object({ provider: z.string(), sessionToken: z.string(), expiresAt: out.dateTime })
    .meta({ id: 'KycSession', description: "For the provider's mobile SDK. Null if the user is already approved." })
    .nullable(),
}).meta({ id: 'KycStart' });

function toDto(view: KycView) {
  return {
    status: view.status,
    tier: view.tier,
    limits: { perPayment: view.limits.perPayment.toString(), perDay: view.limits.perDay.toString() },
  };
}

export const kycRoutes: FastifyPluginAsyncZod<{ kyc: KycService }> = async (app, { kyc }) => {
  app.post(
    '/kyc/start',
    {
      schema: {
        tags: ['kyc'],
        summary: 'Start identity verification (mock: approved on the next status check)',
        operationId: 'startKyc',
        security: bearerAuth,
        response: { 200: KycStartResponse, 401: errorResponses[401] },
      },
    },
    async (request) => {
      const { session, ...view } = await kyc.start(requireUserId(request));
      return {
        ...toDto(view),
        session: session && { ...session, expiresAt: session.expiresAt.toISOString() },
      };
    },
  );

  app.get(
    '/kyc/status',
    {
      schema: {
        tags: ['kyc'],
        summary: 'Verification status, tier and spending limits',
        operationId: 'getKycStatus',
        security: bearerAuth,
        response: { 200: KycStatusResponse, 401: errorResponses[401] },
      },
    },
    async (request) => toDto(await kyc.status(requireUserId(request))),
  );
};
