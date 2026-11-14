import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { Merchant } from '../../domain/merchant.js';
import type { AuthorizationToSign, NearPaymentToSign } from '../../domain/quote.js';
import { RECEIVE_WITH_AUTHORIZATION_TYPES, quoteStruct } from '../../lib/typed-data.js';
import {
  bearerAuth,
  errorResponses,
  minorUnitsSchema,
  out,
  walletSchema,
} from '../../shared/schemas.js';
import { requireUserId } from '../../shared/request-user.js';
import type { QuoteResponse, QuoteService } from './service.js';

const QuoteBody = z.object({
  payer: walletSchema.meta({
    description: "Wallet that will pay; must be the signed-in user's wallet (a NEAR implicit account on the NEAR rail)",
  }),
  qrPayload: z
    .string()
    .min(20)
    .max(512)
    .meta({ description: 'The scanned QR text: a Thai PromptPay QR (THB) or an Indian UPI QR, upi://pay?... (INR)' }),
  fiatAmountMinor: minorUnitsSchema.optional().meta({
    description:
      "Minor units of the QR's currency (THB satang, INR paise). Required when the QR has no amount; must match it when it has one.",
  }),
}).meta({ id: 'QuoteRequest' });

const typedDataField = z.object({ name: z.string(), type: z.string() }).meta({ id: 'TypedDataField' });

const ReceiveAuthorizationTypedData = z
  .object({
    types: z.record(z.string(), z.array(typedDataField)),
    primaryType: z.literal('ReceiveWithAuthorization'),
    domain: z.object({
      name: z.string(),
      version: z.string(),
      chainId: z.number().int(),
      verifyingContract: out.address,
    }).meta({ id: 'Eip712Domain' }),
    message: z.object({
      from: out.address,
      to: out.address,
      value: out.uint,
      validAfter: out.uint,
      validBefore: out.uint,
      nonce: out.bytes32,
    }).meta({ id: 'ReceiveAuthorizationMessage' }),
  });

const NearTransferCallArgs = z
  .object({
    receiver_id: z.string().meta({ description: 'The settlement contract' }),
    amount: out.uint.meta({ description: 'USDC base units: the quote tokenAmount' }),
    msg: z.string().meta({
      description: 'JSON {"quote": <quote JSON>, "signature": <base64 ed25519>} that the settlement contract checks',
    }),
  })
  .meta({ id: 'NearTransferCallArgs', description: 'The `ft_transfer_call` arguments, as JSON' });

const NearPayment = z
  .object({
    signerId: z.string().meta({ description: "The payer's implicit account (the delegate action's sender_id)" }),
    publicKey: z.string().meta({ description: 'The payer\'s key, "ed25519:" + base58' }),
    receiverId: z.string().meta({ description: 'The USDC contract' }),
    methodName: z.string().meta({ description: 'Always "ft_transfer_call"' }),
    args: NearTransferCallArgs,
    gas: out.uint.meta({ description: 'Gas for the function call' }),
    deposit: out.uint.meta({ description: 'yoctoNEAR attached: always 1' }),
    nonce: out.uint.meta({ description: "The delegate action's nonce: the access key's nonce + 1" }),
    maxBlockHeight: out.uint.meta({ description: 'The delegate action is void after this block height' }),
  });

const QuoteDto = z.object({
  quote: z
    .object({
      quoteId: out.bytes32,
      payer: z.string().meta({ description: '0x address (EVM rail) or NEAR implicit account (NEAR rail)' }),
      token: z.string().meta({ description: 'USDC: its 0x address (EVM rail) or contract account ID (NEAR rail)' }),
      tokenAmount: out.uint.meta({ description: 'USDC base units (6 decimals), spread included' }),
      fiatCurrency: z.enum(['THB', 'INR']).meta({ description: 'THB for a PromptPay QR, INR for a UPI QR' }),
      fiatAmount: out.uint.meta({ description: 'Minor units of fiatCurrency (satang, paise) the merchant receives' }),
      merchantRefHash: out.bytes32,
      expiresAt: z.number().int().meta({ description: 'Unix seconds' }),
    })
    .meta({
      id: 'OnChainQuote',
      description: 'The on-chain Quote struct, as signed. Send it back unchanged with the payment.',
    }),
  signature: z.string().meta({
    description:
      "GlobalPay's signature over the quote: EIP-712, 0x hex (EVM rail), or ed25519 over the quote JSON, base64 (NEAR rail)",
  }),
  expiresAt: out.dateTime,
  pricing: z.object({
    rateE8: out.uint.meta({ description: 'Mid-market fiatCurrency per USDC × 1e8' }),
    rateSource: z.string(),
    spreadBps: z.number().int(),
    baseTokenAmount: out.uint.meta({ description: 'USDC at the mid-market rate' }),
    feeTokenAmount: out.uint.meta({ description: 'The spread, in USDC base units' }),
  }).meta({ id: 'QuotePricing' }),
  merchant: z.object({
    kind: z.enum(['personal', 'merchant']),
    targetType: z.enum(['mobile', 'nationalId', 'eWallet', 'biller', 'vpa']),
    targetId: z.string(),
    reference1: z.string().optional(),
    reference2: z.string().optional(),
    merchantName: z.string().optional(),
    merchantCity: z.string().optional(),
  }).meta({ id: 'QuoteMerchant' }),
  // `.optional().meta()`, in this order, keeps them plain $refs in the OpenAPI spec.
  authorizationToSign: ReceiveAuthorizationTypedData.optional().meta({
    id: 'ReceiveAuthorizationTypedData',
    description:
      'EVM rail: EIP-712 typed data for the wallet (eth_signTypedData_v4): USDC ReceiveWithAuthorization. ' +
      'Absent on the NEAR rail.',
  }),
  nearPayment: NearPayment.optional().meta({
    id: 'NearPayment',
    description:
      'NEAR rail: sign this as a NEP-366 delegate action (one FunctionCall), then send the borsh SignedDelegate, ' +
      'base64, as `signedDelegate` to POST /payments. The relayer pays the gas. Absent on the EVM rail.',
  }),
}).meta({ id: 'QuoteResponse' });

function authorizationDto({ domain, message }: AuthorizationToSign): z.infer<typeof ReceiveAuthorizationTypedData> {
  return {
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
  };
}

function nearPaymentDto(payment: NearPaymentToSign): z.infer<typeof NearPayment> {
  return {
    signerId: payment.signerId,
    publicKey: payment.publicKey,
    receiverId: payment.receiverId,
    methodName: payment.methodName,
    args: { ...payment.args },
    gas: payment.gas.toString(),
    deposit: payment.deposit.toString(),
    nonce: payment.nonce.toString(),
    maxBlockHeight: payment.maxBlockHeight.toString(),
  };
}

/**
 * The QR's payee. UPI: a merchant QR if it has a merchant code (mc), targetType "vpa", targetId the VPA (pa),
 * merchantName the payee name (pn), reference1 the transaction reference (tr).
 */
function merchantDto(merchant: Merchant): z.infer<typeof QuoteDto>['merchant'] {
  if (merchant.kind === 'upi') {
    return {
      kind: merchant.merchantCode === undefined ? 'personal' : 'merchant',
      targetType: 'vpa',
      targetId: merchant.vpa,
      ...(merchant.reference === undefined ? {} : { reference1: merchant.reference }),
      ...(merchant.name === undefined ? {} : { merchantName: merchant.name }),
    };
  }
  return {
    kind: merchant.kind,
    targetType: merchant.targetType,
    targetId: merchant.targetId,
    ...(merchant.reference1 === undefined ? {} : { reference1: merchant.reference1 }),
    ...(merchant.reference2 === undefined ? {} : { reference2: merchant.reference2 }),
    ...(merchant.merchantName === undefined ? {} : { merchantName: merchant.merchantName }),
    ...(merchant.merchantCity === undefined ? {} : { merchantCity: merchant.merchantCity }),
  };
}

function toDto({ quote, signature, pricing, authorizationToSign, nearPayment }: QuoteResponse): z.infer<typeof QuoteDto> {
  const struct = quoteStruct(quote);
  const { merchant } = quote;
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
    merchant: merchantDto(merchant),
    ...(authorizationToSign ? { authorizationToSign: authorizationDto(authorizationToSign) } : {}),
    ...(nearPayment ? { nearPayment: nearPaymentDto(nearPayment) } : {}),
  };
}

export const quoteRoutes: FastifyPluginAsyncZod<{ quotes: QuoteService }> = async (app, { quotes }) => {
  app.post(
    '/quotes',
    {
      schema: {
        tags: ['quotes'],
        summary: 'Quote a PromptPay or UPI QR payment in USDC',
        operationId: 'createQuote',
        description:
          'Parses the QR (PromptPay: THB, UPI: INR), checks KYC limits, prices it at the live rate plus the spread, ' +
          'and signs it. ' +
          'The quote expires after QUOTE_TTL_SECONDS (60 s by default). ' +
          'EVM rail: sign `authorizationToSign` with the payer wallet. NEAR rail: sign `nearPayment` as a ' +
          'delegate action. Then submit it to POST /payments.',
        security: bearerAuth,
        body: QuoteBody,
        response: {
          201: QuoteDto,
          400: errorResponses[400],
          401: errorResponses[401],
          403: errorResponses[403],
          422: errorResponses[422],
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
