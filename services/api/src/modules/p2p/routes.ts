import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { bearerAuth, bytes32Schema, errorResponses, hexSchema, minorUnitsSchema, out } from '../../shared/schemas.js';
import { requireUserId } from '../../shared/request-user.js';
import type { P2pService } from './service.js';

export const P2pRequestDto = z
  .object({
    id: z.string(),
    role: z.enum(['receiver', 'sender']).meta({ description: 'Your side of the request' }),
    status: z.enum(['CREATED', 'SENDER_IDENTIFIED', 'SUBMITTED', 'COMPLETED', 'FAILED', 'EXPIRED', 'DECLINED', 'CANCELLED']).meta({
      description:
        'CREATED: waiting for a tap or a scan. SENDER_IDENTIFIED: waiting for the sender to approve. SUBMITTED: transfer sent. ' +
        'COMPLETED and FAILED: the transfer was mined (or reverted). EXPIRED, DECLINED, CANCELLED: nothing moved.',
    }),
    token: out.address,
    amount: out.uint.meta({ description: 'USDC base units' }),
    recipient: z
      .object({ name: z.string(), verified: z.boolean().meta({ description: 'The name comes from identity verification' }), address: out.address })
      .meta({ id: 'P2pRecipient' }),
    sender: z.object({ address: out.address }).optional().meta({ id: 'P2pSender' }),
    challenge: out.bytes32.optional().meta({ description: 'Receiver only, while CREATED: send it to the other phone over NFC, or show it in the QR' }),
    transaction: z.object({ hash: out.bytes32, url: z.string() }).optional().meta({ id: 'P2pTransaction' }),
    failureReason: z.string().optional(),
    expiresAt: out.dateTime,
    createdAt: out.dateTime,
    updatedAt: out.dateTime,
  })
  .meta({ id: 'P2pRequest' });

const Params = z.object({ id: z.string().min(1) });
const ok = { 401: errorResponses[401], 404: errorResponses[404] };
const actionErrors = { ...ok, 409: errorResponses[409], 422: errorResponses[422] };

export const p2pRoutes: FastifyPluginAsyncZod<{ p2p: P2pService }> = async (app, { p2p }) => {
  const tags = ['p2p'];

  app.put(
    '/me/profile',
    {
      schema: {
        tags: ['account'],
        summary: 'Set the name others see when paying you',
        operationId: 'updateProfile',
        security: bearerAuth,
        body: z.object({ displayName: z.string().max(80) }).meta({ id: 'ProfileUpdate' }),
        response: {
          200: z.object({ displayName: z.string(), nameVerified: z.boolean() }).meta({ id: 'Profile' }),
          401: errorResponses[401],
          422: errorResponses[422],
        },
      },
    },
    async (request) => p2p.updateProfile(requireUserId(request), request.body.displayName),
  );

  app.post(
    '/devices',
    {
      schema: {
        tags,
        summary: "Register this phone's hardware key (and push token) for tap to pay",
        operationId: 'registerDevice',
        description: 'Registering the same key again refreshes its push token. The returned ID is what the phone announces when tapped.',
        security: bearerAuth,
        body: z
          .object({
            publicKey: z.string().min(40).max(400).meta({ description: 'P-256 public key, SPKI DER, base64' }),
            platform: z.enum(['android', 'ios']),
            fcmToken: z.string().min(1).max(4096).optional(),
          })
          .meta({ id: 'DeviceRegistration' }),
        response: { 201: z.object({ id: z.string() }).meta({ id: 'Device' }), 401: errorResponses[401], 409: errorResponses[409], 422: errorResponses[422] },
      },
    },
    async (request, reply) => reply.code(201).send(await p2p.registerDevice(requireUserId(request), request.body)),
  );

  app.delete(
    '/devices/:id',
    {
      schema: { tags, summary: 'Stop this phone being used to pay', operationId: 'revokeDevice', security: bearerAuth, params: Params, response: { 204: z.null(), ...ok } },
    },
    async (request, reply) => {
      await p2p.revokeDevice(requireUserId(request), request.params.id);
      return reply.code(204).send(null);
    },
  );

  app.post(
    '/p2p/requests',
    {
      schema: {
        tags,
        summary: 'Ask someone to pay you (tap to pay, or they scan your QR)',
        operationId: 'createPaymentRequest',
        description: 'Expires after 2 minutes. Show the QR (request ID and challenge) or hold the other phone near yours.',
        security: bearerAuth,
        body: z.object({ amount: minorUnitsSchema.meta({ description: 'USDC base units, e.g. "5000000" = 5 USDC' }) }).meta({ id: 'PaymentRequestCreate' }),
        response: { 201: P2pRequestDto, 401: errorResponses[401], 403: errorResponses[403], 422: errorResponses[422], 429: errorResponses[429] },
      },
    },
    async (request, reply) => reply.code(201).send(await p2p.createRequest(requireUserId(request), request.body.amount)),
  );

  app.get(
    '/p2p/requests',
    {
      schema: {
        tags,
        summary: 'Requests you received or paid, newest first (last 50)',
        operationId: 'listPaymentRequests',
        security: bearerAuth,
        response: { 200: z.object({ requests: z.array(P2pRequestDto) }).meta({ id: 'P2pRequestList' }), 401: errorResponses[401] },
      },
    },
    async (request) => ({ requests: await p2p.list(requireUserId(request)) }),
  );

  app.get(
    '/p2p/incoming',
    {
      schema: {
        tags,
        summary: 'Requests waiting for your approval',
        operationId: 'listIncomingRequests',
        description: 'Poll this while the tap screen is open, in case a push notification is slow or push is off.',
        security: bearerAuth,
        response: { 200: z.object({ requests: z.array(P2pRequestDto) }).meta({ id: 'P2pIncomingList' }), 401: errorResponses[401] },
      },
    },
    async (request) => ({ requests: await p2p.incoming(requireUserId(request)) }),
  );

  app.get(
    '/p2p/requests/:id',
    {
      schema: { tags, summary: 'A request you received or are paying', operationId: 'getPaymentRequest', security: bearerAuth, params: Params, response: { 200: P2pRequestDto, ...ok } },
    },
    async (request) => p2p.get(requireUserId(request), request.params.id),
  );

  app.post(
    '/p2p/requests/:id/tap',
    {
      schema: {
        tags,
        summary: "Receiver: forward the other phone's NFC answer",
        operationId: 'tapPaymentRequest',
        description: 'The device ID the other phone announced, and its P-256 signature (DER) over "GLOBALPAY-TAP-1" followed by the challenge.',
        security: bearerAuth,
        params: Params,
        body: z.object({ deviceId: z.string().min(1).max(64), signature: hexSchema }).meta({ id: 'TapAnswer' }),
        response: { 200: P2pRequestDto, ...actionErrors, 429: errorResponses[429] },
      },
    },
    async (request) => p2p.tap(requireUserId(request), request.params.id, request.body),
  );

  app.post(
    '/p2p/requests/:id/claim',
    {
      schema: {
        tags,
        summary: "Sender: claim a request from the receiver's QR",
        operationId: 'claimPaymentRequest',
        security: bearerAuth,
        params: Params,
        body: z.object({ challenge: bytes32Schema }).meta({ id: 'ClaimRequest' }),
        response: { 200: P2pRequestDto, ...actionErrors, 429: errorResponses[429] },
      },
    },
    async (request) => p2p.claim(requireUserId(request), request.params.id, request.body.challenge),
  );

  app.get(
    '/p2p/requests/:id/authorization',
    {
      schema: {
        tags,
        summary: 'Sender: the USDC transfer to sign (EIP-712 TransferWithAuthorization)',
        operationId: 'getPaymentRequestAuthorization',
        security: bearerAuth,
        params: Params,
        response: {
          200: z
            .object({
              domain: z.object({ name: z.string(), version: z.string(), chainId: z.number().int(), verifyingContract: out.address }).meta({ id: 'TransferDomain' }),
              types: z.record(z.string(), z.array(z.object({ name: z.string(), type: z.string() }))),
              primaryType: z.literal('TransferWithAuthorization'),
              message: z
                .object({ from: out.address, to: out.address, value: out.uint, validAfter: out.uint, validBefore: out.uint, nonce: out.bytes32 })
                .meta({ id: 'TransferMessage' }),
            })
            .meta({ id: 'TransferToSign' }),
          ...actionErrors,
        },
      },
    },
    async (request) => {
      const typed = await p2p.authorization(requireUserId(request), request.params.id);
      const { message } = typed;
      return {
        ...typed,
        types: { TransferWithAuthorization: typed.types.TransferWithAuthorization.map((field) => ({ ...field })) },
        message: { ...message, value: message.value.toString(), validAfter: message.validAfter.toString(), validBefore: message.validBefore.toString() },
      };
    },
  );

  for (const [action, summary, operationId] of [
    ['decline', 'Sender: decline the request', 'declinePaymentRequest'],
    ['cancel', 'Receiver: cancel the request', 'cancelPaymentRequest'],
  ] as const) {
    app.post(
      `/p2p/requests/:id/${action}`,
      { schema: { tags, summary, operationId, security: bearerAuth, params: Params, response: { 200: P2pRequestDto, ...actionErrors } } },
      async (request) =>
        action === 'decline' ? p2p.decline(requireUserId(request), request.params.id) : p2p.cancel(requireUserId(request), request.params.id),
    );
  }

  app.post(
    '/p2p/requests/:id/approve',
    {
      schema: {
        tags,
        summary: 'Sender: approve with the signed transfer; the backend relays it',
        operationId: 'approvePaymentRequest',
        security: bearerAuth,
        params: Params,
        body: z.object({ signature: hexSchema.meta({ description: "The sender's wallet signature over the TransferWithAuthorization" }) }).meta({ id: 'ApproveRequest' }),
        response: { 200: P2pRequestDto, ...actionErrors, 403: errorResponses[403], 503: errorResponses[503] },
      },
    },
    async (request) => p2p.approve(requireUserId(request), request.params.id, request.body.signature),
  );
};
