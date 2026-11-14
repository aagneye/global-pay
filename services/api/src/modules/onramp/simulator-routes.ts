import type { FastifyPluginAsync, FastifyReply } from 'fastify';
import { SimulatedOnrampProvider } from '../../adapters/onramp/simulated-onramp-provider.js';
import { FIAT_DECIMALS, formatMinor } from '../../domain/money.js';
import { AppError } from '../../shared/errors.js';
import type { OnrampService } from './service.js';

const SECURITY = {
  'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
  'referrer-policy': 'no-referrer',
  'cache-control': 'no-store',
};

/**
 * The simulated onramp's checkout page, for local development: "pay" (sends test USDC on anvil) or
 * "decline". Only registered with the simulated partner, which production refuses. Plain HTML forms,
 * no script. Hidden from the OpenAPI spec.
 */
export const onrampSimulatorRoutes: FastifyPluginAsync<{ onramp: OnrampService }> = async (app, { onramp }) => {
  const simulator = onramp.provider;
  if (!(simulator instanceof SimulatedOnrampProvider)) return;
  app.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string' }, (_request, _body, done) => done(null, {}));

  const page = (reply: FastifyReply, title: string, body: string) =>
    reply
      .headers(SECURITY)
      .type('text/html; charset=utf-8')
      .send(
        `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">` +
          `<title>${title}</title><style>body{font:16px system-ui,sans-serif;max-width:28rem;margin:2rem auto;padding:0 16px}` +
          `button{font:inherit;padding:.6rem 1rem;margin:.25rem .5rem .25rem 0}.note{color:#666;font-size:14px}</style></head>` +
          `<body><h1>${title}</h1>${body}<p class="note">Simulated onramp: no real money. Test USDC is minted on the local chain.</p></body></html>`,
      );

  app.get<{ Params: { orderId: string } }>('/onramp/simulator/:orderId', { schema: { hide: true } }, async (request, reply) => {
    const { orderId } = request.params;
    const checkout = simulator.checkout(orderId);
    if (!checkout) throw new AppError('not_found', 'No such checkout (the API may have restarted)', 404);
    const purchase = await simulator.findByOrderId(orderId);
    const amount = `${formatMinor(checkout.fiat.minor, FIAT_DECIMALS[checkout.fiat.currency])} ${checkout.fiat.currency}`;
    const path = `/onramp/simulator/${encodeURIComponent(orderId)}`;
    if (purchase && purchase.status !== 'waiting') {
      const done = purchase.status === 'failed' ? 'Payment declined.' : 'Paid. The USDC is on its way to your wallet.';
      return page(reply, 'GlobalPay test checkout', `<p>${done}</p><p>You can go back to the app.</p>`);
    }
    return page(
      reply,
      'GlobalPay test checkout',
      `<p>Buy USDC for <strong>${amount}</strong>, sent to <code>${checkout.walletAddress}</code>.</p>` +
        `<form method="post" action="${path}/pay"><button type="submit">Pay with test card</button></form>` +
        `<form method="post" action="${path}/decline"><button type="submit">Decline</button></form>`,
    );
  });

  for (const action of ['pay', 'decline'] as const) {
    app.post<{ Params: { orderId: string } }>(`/onramp/simulator/:orderId/${action}`, { schema: { hide: true } }, async (request, reply) => {
      const { orderId } = request.params;
      if (action === 'pay') await simulator.pay(orderId);
      else simulator.decline(orderId);
      // Update the order now rather than at the worker's next pass.
      await onramp.refresh(orderId);
      return reply.redirect(`/onramp/simulator/${encodeURIComponent(orderId)}`, 303);
    });
  }
};
