import { createHmac } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { MoonPayOnrampProvider } from '../src/adapters/onramp/moonpay-provider.js';

const WALLET = '0x15d34AAf54267DB7D7c367839AAf71A00a2C6A65';
const checkout = { orderId: 'order_1', walletAddress: WALLET, fiat: { currency: 'THB' as const, minor: 800_00n } } as const;

function moonpay(respond: (url: string) => Response | Promise<Response> = () => json(404, {}), options: Record<string, unknown> = {}) {
  const urls: string[] = [];
  const fetch = vi.fn<typeof globalThis.fetch>(async (url) => {
    urls.push(String(url));
    return respond(String(url));
  });
  const provider = new MoonPayOnrampProvider({
    publishableKey: 'pk_test_abc',
    secretKey: 'sk_test_secret',
    webhookKey: 'wk_test_hook',
    fetch,
    ...options,
  });
  return { provider, urls };
}
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });
const tx = (status: string, extra: Record<string, unknown> = {}) => ({
  id: `mp_${status}`,
  status,
  externalTransactionId: 'order_1',
  walletAddress: WALLET.toLowerCase(),
  createdAt: '2026-11-14T10:00:00.000Z',
  ...extra,
});

/** A webhook as MoonPay sends it: Moonpay-Signature-V2 over `t.rawBody`. */
function webhook(body: unknown, { key = 'wk_test_hook', at = new Date() }: { key?: string; at?: Date } = {}) {
  const raw = JSON.stringify(body);
  const t = Math.floor(at.getTime() / 1000);
  const s = createHmac('sha256', key).update(`${t}.${raw}`).digest('hex');
  return { raw, headers: { 'moonpay-signature-v2': `t=${t},s=${s}` } };
}

describe('MoonPayOnrampProvider', () => {
  it('builds a widget URL signed over its query string, with the signature last', () => {
    const url = moonpay().provider.checkoutUrl(checkout);
    const parsed = new URL(url);
    expect(parsed.origin).toBe('https://buy-sandbox.moonpay.com');
    expect(Object.fromEntries(parsed.searchParams)).toMatchObject({
      apiKey: 'pk_test_abc',
      currencyCode: 'usdc_base',
      walletAddress: WALLET,
      baseCurrencyCode: 'thb',
      baseCurrencyAmount: '800.00',
      externalTransactionId: 'order_1',
    });
    const [unsigned, signature] = url.split('&signature=');
    expect(decodeURIComponent(signature!)).toBe(
      createHmac('sha256', 'sk_test_secret').update(new URL(unsigned!).search).digest('base64'),
    );
    expect(url).not.toContain('sk_test_secret');
  });

  it('adds the redirect link when configured', () => {
    const url = moonpay(undefined, { redirectUrl: 'https://globalpay.example/onramp/done' }).provider.checkoutUrl(checkout);
    expect(new URL(url).searchParams.get('redirectURL')).toBe('https://globalpay.example/onramp/done');
  });

  it.each([
    ['waitingPayment', 'waiting'],
    ['waitingAuthorization', 'pending'],
    ['pending', 'pending'],
    ['completed', 'completed'],
    ['failed', 'failed'],
    ['somethingNew', 'pending'],
  ])('maps %s to %s', async (status, expected) => {
    const { provider } = moonpay(() => json(200, [tx(status)]));
    await expect(provider.findByOrderId('order_1')).resolves.toMatchObject({ status: expected, providerStatus: status });
  });

  it('reads the amount, the delivering transaction and the wallet', async () => {
    const hash = `0x${'ab'.repeat(32)}`;
    const { provider, urls } = moonpay(() => json(200, [tx('completed', { quoteCurrencyAmount: 24.712345, cryptoTransactionId: hash })]));
    await expect(provider.findByOrderId('order_1')).resolves.toMatchObject({
      status: 'completed',
      providerTxId: 'mp_completed',
      tokenAmount: 24_712_345n,
      txHash: hash,
      walletAddress: WALLET,
    });
    expect(urls[0]).toBe('https://api.moonpay.com/v1/transactions/ext/order_1?apiKey=pk_test_abc');
  });

  it('picks the completed purchase when the user tried more than once, and accepts a single object', async () => {
    const several = moonpay(() =>
      json(200, [tx('failed', { id: 'mp_1', createdAt: '2026-11-14T11:00:00Z' }), tx('completed', { id: 'mp_2', createdAt: '2026-11-14T10:00:00Z' })]),
    );
    await expect(several.provider.findByOrderId('order_1')).resolves.toMatchObject({ providerTxId: 'mp_2' });

    const single = moonpay(() => json(200, tx('pending')));
    await expect(single.provider.findByOrderId('order_1')).resolves.toMatchObject({ status: 'pending' });
  });

  it('says so when there is no purchase, and throws when MoonPay is down', async () => {
    await expect(moonpay(() => json(404, {})).provider.findByOrderId('order_1')).resolves.toBeNull();
    await expect(moonpay(() => json(200, [])).provider.findByOrderId('order_1')).resolves.toBeNull();
    await expect(moonpay(() => json(502, {})).provider.findByOrderId('order_1')).rejects.toThrow(/502/);
    await expect(moonpay(() => json(401, {})).provider.findByOrderId('order_1')).rejects.toMatchObject({ code: 'onramp_partner_error' });
  });

  it('accepts a webhook only with a valid, fresh signature over the exact body', () => {
    const { provider } = moonpay();
    const now = new Date('2026-11-14T10:00:00Z');
    const body = { type: 'transaction_updated', data: tx('completed') };

    const valid = webhook(body, { at: now });
    expect(provider.parseWebhook(valid.headers, valid.raw, now)).toEqual({ orderId: 'order_1' });

    // Tampered body, wrong key, missing header.
    expect(provider.parseWebhook(valid.headers, valid.raw.replace('completed', 'failed'), now)).toBeNull();
    const wrongKey = webhook(body, { key: 'someone-else', at: now });
    expect(provider.parseWebhook(wrongKey.headers, wrongKey.raw, now)).toBeNull();
    expect(provider.parseWebhook({}, valid.raw, now)).toBeNull();

    // Replayed: a real signature, but ten minutes old.
    const old = webhook(body, { at: new Date(now.getTime() - 10 * 60_000) });
    expect(provider.parseWebhook(old.headers, old.raw, now)).toBeNull();
  });

  it('refuses every webhook when no webhook key is configured', () => {
    const { provider } = moonpay(undefined, { webhookKey: undefined });
    const signed = webhook({ data: tx('completed') });
    expect(provider.parseWebhook(signed.headers, signed.raw, new Date())).toBeNull();
  });
});
