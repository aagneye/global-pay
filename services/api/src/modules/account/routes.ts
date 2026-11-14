import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { bearerAuth, errorResponses, out } from '../../shared/schemas.js';
import { requireUserId } from '../../shared/request-user.js';
import { PaymentDto } from '../payments/routes.js';
import type { AccountService } from './service.js';

const BalanceDto = z.object({
  token: z.string().meta({ description: 'USDC: its 0x address (EVM rail) or contract account ID (NEAR rail)' }),
  units: out.uint.meta({ description: 'Token base units' }),
  decimals: z.number().int(),
}).meta({ id: 'Balance' });

const DepositDto = z.object({
  id: z.string(),
  token: out.address,
  amount: out.uint.meta({ description: 'Token base units' }),
  from: out.address,
  transaction: z.object({ hash: out.bytes32, url: z.string() }).meta({ id: 'DepositTransaction' }),
  onrampOrderId: z.string().optional().meta({ description: 'The Add-money order this completed' }),
  createdAt: out.dateTime,
}).meta({ id: 'Deposit' });

export const accountRoutes: FastifyPluginAsyncZod<{ account: AccountService }> = async (app, { account }) => {
  app.get(
    '/me/balance',
    {
      schema: {
        tags: ['account'],
        summary: "USDC balance of the signed-in user's wallet",
        operationId: 'getBalance',
        security: bearerAuth,
        response: { 200: BalanceDto, 401: errorResponses[401], 503: errorResponses[503] },
      },
    },
    async (request) => {
      const { token, units, decimals } = await account.balance(requireUserId(request));
      return { token, units: units.toString(), decimals };
    },
  );

  app.get(
    '/me/payments',
    {
      schema: {
        tags: ['account'],
        summary: 'Payment history, newest first (last 50)',
        operationId: 'listPayments',
        security: bearerAuth,
        response: {
          200: z.object({ payments: z.array(PaymentDto) }).meta({ id: 'PaymentList' }),
          401: errorResponses[401],
        },
      },
    },
    async (request) => ({ payments: await account.payments(requireUserId(request)) }),
  );

  app.get(
    '/me/deposits',
    {
      schema: {
        tags: ['account'],
        summary: 'USDC that arrived in your wallet from outside, newest first (last 50)',
        operationId: 'listDeposits',
        description: 'Found on-chain by the deposit watcher, a few blocks after they land. Refunds show on their payment instead.',
        security: bearerAuth,
        response: {
          200: z.object({ deposits: z.array(DepositDto) }).meta({ id: 'DepositList' }),
          401: errorResponses[401],
        },
      },
    },
    async (request) => ({ deposits: await account.deposits(requireUserId(request)) }),
  );
};
