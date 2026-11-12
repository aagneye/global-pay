import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { RECEIVE_WITH_AUTHORIZATION_TYPES, quoteStruct } from '../../lib/typed-data.js';
import {
  addressSchema,
  bearerAuth,
  errorResponseSchema,
  errorResponses,
  minorUnitsSchema,
  out,
} from '../../shared/schemas.js';
import { requireUserId } from '../../shared/request-user.js';
import type { QuoteResponse, QuoteService } from './service.js';

const QuoteBody = z.object({
  payer: addressSchema.meta({ description: "Wallet that will pay; must be the signed-in user's wallet" }),
  qrPayload: z.string().min(20).max(512).meta({ description: 'The scanned PromptPay QR text' }),
  fiatAmountMinor: minorUnitsSchema
    .optional()
    .meta({ description: 'THB satang. Required when the QR has no amount; must match it when it has one.' }),
});

const typedDataField = z.object({ name: z.string(), type: z.string() });

const QuoteDto = z.object({
  quote: z
    .object({
      quoteId: out.bytes32,
      payer: out.address,
      token: out.address,
      tokenAmount: out.uint.meta({ description: 'USDC base units (6 decimals), spread included' }),
      fiatCurrency: z.literal('THB'),
      fiatAmount: out.uint.meta({ description: 'THB satang the merchant receives' }),
      merchantRefHash: out.bytes32,
      expiresAt: z.number().int().meta({ description: 'Unix seconds' }),
    })
    .meta({ description: 'The on-chain Quote struct, as signed. Send it back unchanged with the payment.' }),
  signature: out.hex.meta({ description: "GlobalPay's EIP-712 signature over the quote" }),
  expiresAt: out.dateTime,
  pricing: z.object({
    rateE8: out.uint.meta({ description: 'Mid-market THB per USDC × 1e8' }),
    rateSource: z.string(),
    spreadBps: z.number().int(),
    baseTokenAmount: out.uint.meta({ description: 'USDC at the mid-market rate' }),
    feeTokenAmount: out.uint.meta({ description: 'The spread, in USDC base units' }),
  }),
  merchant: z.object({
    kind: z.enum(['personal', 'merchant']),
    targetType: z.enum(['mobile', 'nationalId', 'eWallet', 'biller']),
    targetId: z.string(),
    reference1: z.string().optional(),
    reference2: z.string().optional(),
    merchantName: z.string().optional(),
    merchantCity: z.string().optional(),
  }),
  authorizationToSign: z
    .object({
      types: z.record(z.string(), z.array(typedDataField)),
      primaryType: z.literal('ReceiveWithAuthorization'),
      domain: z.object({
        name: z.string(),
        version: z.string(),
        chainId: z.number().int(),
        verifyingContract: out.address,
      }),
      message: z.object({
        from: out.address,
        to: out.address,
        value: out.uint,
        validAfter: out.uint,
        validBefore: out.uint,
        nonce: out.bytes32,
      }),
    })
    .meta({ description: 'EIP-712 typed data for the wallet (eth_signTypedData_v4): USDC ReceiveWithAuthorization' }),
});

function toDto({ quote, signature, pricing, authorizationToSign }: QuoteResponse): z.infer<typeof QuoteDto> {
  const struct = quoteStruct(quote);
  const { merchant } = quote;
  const { domain, message } = authorizationToSign;
  return {
    quote: {
      quoteId: struct.quoteId,
      payer: struct.payer,
      token: struct.token,
      tokenAmount: struct.tokenAmount.toString(),
      fiatCurrency: quote.fiat.currency,
      fiatAmount: struct.fiatAmount.toString(),
      merchantRefHash: struct.merchantRefHash,
      expiresAt: Number(struct.expiresAt),
    },
    signature,
    expiresAt: quote.expiresAt.toISOString(),
    pricing: {
      rateE8: quote.rateE8.toString(),
      rateSource: pricing.rateSource,
      spreadBps: quote.spreadBps,
      baseTokenAmount: pricing.baseTokenAmount.toString(),
      feeTokenAmount: pricing.feeTokenAmount.toString(),
    },
    merchant: {
      kind: merchant.kind,
      targetType: merchant.targetType,
      targetId: merchant.targetId,
      ...(merchant.reference1 === undefined ? {} : { reference1: merchant.reference1 }),
      ...(merchant.reference2 === undefined ? {} : { reference2: merchant.reference2 }),
      ...(merchant.merchantName === undefined ? {} : { merchantName: merchant.merchantName }),
      ...(merchant.merchantCity === undefined ? {} : { merchantCity: merchant.merchantCity }),
    },
    authorizationToSign: {
      types: {
        EIP712Domain: [
          { name: 'name', type: 'string' },
          { name: 'version', type: 'string' },
          { name: 'chainId', type: 'uint256' },
          { name: 'verifyingContract', type: 'address' },
        ],
        ReceiveWithAuthorization: [...RECEIVE_WITH_AUTHORIZATION_TYPES.ReceiveWithAuthorization],
      },
      primaryType: 'ReceiveWithAuthorization',
      domain,
      message: {
        from: message.from,
        to: message.to,
        value: message.value.toString(),
        validAfter: message.validAfter.toString(),
        validBefore: message.validBefore.toString(),
        nonce: message.nonce,
      },
    },
  };
}

export const quoteRoutes: FastifyPluginAsyncZod<{ quotes: QuoteService }> = async (app, { quotes }) => {
  app.post(
    '/quotes',
    {
      schema: {
        tags: ['quotes'],
        summary: 'Quote a PromptPay QR payment in USDC',
        description:
          'Parses the QR, checks KYC limits, prices it at the live rate plus the spread, and signs it. ' +
          'The quote expires after QUOTE_TTL_SECONDS (60 s by default). ' +
          'Sign `authorizationToSign` with the payer wallet, then submit it to POST /payments.',
        security: bearerAuth,
        body: QuoteBody,
        response: {
          201: QuoteDto,
          400: errorResponses[400],
          401: errorResponses[401],
          403: errorResponseSchema.meta({ description: 'KYC not approved, or the payer is not your wallet' }),
          422: errorResponseSchema.meta({ description: 'Invalid QR, amount or limit' }),
          503: errorResponses[503],
        },
      },
    },
    async (request, reply) => {
      const userId = requireUserId(request);
      const quote = await quotes.createQuote({ userId, ...request.body });
      return reply.code(201).send(toDto(quote));
    },
  );
};
