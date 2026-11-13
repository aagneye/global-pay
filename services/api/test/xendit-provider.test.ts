import { describe, expect, it, vi } from 'vitest';
import { XenditPayoutProvider } from '../src/adapters/payouts/xendit-provider.js';
import { buildPromptPayQr } from '../src/lib/promptpay/build.js';
import { parsePromptPayQr } from '../src/lib/promptpay/parse.js';

const personal = parsePromptPayQr(
  buildPromptPayQr({ kind: 'personal', targetType: 'mobile', targetId: '0066812345678', amount: { currency: 'THB', minor: 250_00n } }),
);
const biller = parsePromptPayQr(
  buildPromptPayQr({ kind: 'merchant', targetType: 'biller', targetId: '099999999999901', reference1: 'INV1' }),
);
const request = { idempotencyKey: 'pay_1', paymentId: 'pay_1', merchant: personal, amount: { currency: 'THB' as const, minor: 250_50n } };

type Call = { url: string; init: RequestInit };

function xendit(respond: (call: Call) => Response | Promise<Response>, options: Record<string, unknown> = {}) {
  const calls: Call[] = [];
  const fetch = vi.fn<typeof globalThis.fetch>(async (url, init) => {
    const call = { url: String(url), init: init ?? {} };
    calls.push(call);
    return respond(call);
  });
  const provider = new XenditPayoutProvider({
    secretKey: 'xnd_development_secret',
    callbackToken: 'cb-token',
    promptPayChannelCode: 'TH_PROMPTPAY',
    fetch,
    ...options,
  });
  return { provider, calls };
}

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });
const payout = (status: string, extra: Record<string, unknown> = {}) => ({
  id: 'disb-1',
  reference_id: 'pay_1',
  status,
  ...extra,
});

describe('XenditPayoutProvider', () => {
  it('creates a payout with the idempotency key, our reference and the PromptPay ID', async () => {
    const { provider, calls } = xendit(() => json(200, payout('ACCEPTED')));

    await expect(provider.createPayout(request)).resolves.toMatchObject({
      status: 'pending',
      providerRef: 'disb-1',
      providerStatus: 'ACCEPTED',
    });

    const [call] = calls;
    const headers = call?.init.headers as Record<string, string>;
    expect(call?.url).toBe('https://api.xendit.co/v2/payouts');
    expect(headers['Idempotency-key']).toBe('pay_1');
    expect(headers.authorization).toBe(`Basic ${Buffer.from('xnd_development_secret:').toString('base64')}`);
    expect(JSON.parse(String(call?.init.body))).toEqual({
      reference_id: 'pay_1',
      channel_code: 'TH_PROMPTPAY',
      channel_properties: { account_holder_name: 'PromptPay recipient', account_number: '0066812345678' },
      amount: 250.5,
      currency: 'THB',
      description: 'GlobalPay pay_1',
    });
  });

  it.each([
    ['ACCEPTED', { status: 'pending' }],
    ['REQUESTED', { status: 'pending' }],
    ['SUCCEEDED', { status: 'succeeded', reference: 'disb-1' }],
    ['FAILED', { status: 'failed', reason: 'INSUFFICIENT_BALANCE' }],
    ['CANCELLED', { status: 'failed', reason: 'Payout cancelled' }],
    ['REVERSED', { status: 'reversed' }],
    ['SOMETHING_NEW', { status: 'unknown' }],
  ])('maps %s', async (status, expected) => {
    const extra = status === 'FAILED' ? { failure_code: 'INSUFFICIENT_BALANCE' } : {};
    const { provider } = xendit(() => json(200, payout(status, extra)));
    await expect(provider.getPayout('disb-1')).resolves.toMatchObject(expected);
  });

  it('prefers the rail reference over its own ID when it has one', async () => {
    const { provider } = xendit(() => json(200, payout('SUCCEEDED', { processor_reference: 'BANK-778899' })));
    await expect(provider.getPayout('disb-1')).resolves.toMatchObject({ reference: 'BANK-778899' });
  });

  it('treats a timeout or server error on create as unknown, never as failed', async () => {
    const timeout = xendit(() => Promise.reject(new DOMException('The operation timed out', 'TimeoutError')));
    await expect(timeout.provider.createPayout(request)).resolves.toMatchObject({ status: 'unknown' });

    const serverError = xendit(() => json(503, { error_code: 'SERVER_ERROR' }));
    await expect(serverError.provider.createPayout(request)).resolves.toMatchObject({ status: 'unknown' });

    const duplicate = xendit(() => json(409, { error_code: 'DUPLICATE_ERROR' }));
    await expect(duplicate.provider.createPayout(request)).resolves.toMatchObject({ status: 'unknown' });
  });

  it('treats a validation error as a definite failure, and a credentials error as retryable', async () => {
    const invalid = xendit(() => json(400, { error_code: 'INVALID_DESTINATION' }));
    await expect(invalid.provider.createPayout(request)).resolves.toMatchObject({
      status: 'failed',
      reason: 'Xendit rejected the payout: INVALID_DESTINATION',
    });

    const unauthorized = xendit(() => json(401, { error_code: 'INVALID_API_KEY' }));
    await expect(unauthorized.provider.createPayout(request)).rejects.toMatchObject({ code: 'payout_partner_error' });
  });

  it('finds a payout by our reference, and says so when there is none', async () => {
    const found = xendit(() => json(200, { data: [payout('SUCCEEDED')] }));
    await expect(found.provider.findByIdempotencyKey('pay_1')).resolves.toMatchObject({ status: 'succeeded' });
    expect(found.calls[0]?.url).toBe('https://api.xendit.co/v2/payouts?reference_id=pay_1');

    const none = xendit(() => json(200, []));
    await expect(none.provider.findByIdempotencyKey('pay_1')).resolves.toBeNull();

    const down = xendit(() => json(502, {}));
    await expect(down.provider.findByIdempotencyKey('pay_1')).rejects.toThrow();
  });

  it('pays only the QR types it can: PromptPay IDs, or configured sandbox destinations', async () => {
    const { provider } = xendit(() => json(200, payout('ACCEPTED')));
    expect(provider.supports(personal)).toBe(true);
    expect(provider.supports(biller)).toBe(false);
    await expect(provider.createPayout({ ...request, merchant: biller })).resolves.toMatchObject({ status: 'failed' });

    const sandbox = xendit(() => json(200, payout('ACCEPTED')), {
      promptPayChannelCode: undefined,
      testDestinations: {
        '099999999999901': { channelCode: 'TH_KBANK', accountNumber: '1234567890', accountHolderName: 'Test Cafe' },
      },
    });
    expect(sandbox.provider.supports(biller)).toBe(true);
    expect(sandbox.provider.supports(personal)).toBe(false);
  });

  it('reads and caches the THB balance', async () => {
    let now = 0;
    const { provider, calls } = xendit(() => json(200, { balance: 1500.25 }), { now: () => now });
    await expect(provider.getBalance()).resolves.toEqual({ currency: 'THB', minor: 150_025n });
    now = 10_000;
    await provider.getBalance();
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe('https://api.xendit.co/balance?account_type=CASH&currency=THB');
  });

  it('accepts a webhook only with the right callback token', () => {
    const { provider } = xendit(() => json(200, {}));
    const body = { event: 'payout.succeeded', data: payout('SUCCEEDED') };
    expect(provider.parseWebhook({ 'x-callback-token': 'cb-token' }, body)).toEqual({
      providerRef: 'disb-1',
      idempotencyKey: 'pay_1',
    });
    expect(provider.parseWebhook({ 'x-callback-token': 'wrong' }, body)).toBeNull();
    expect(provider.parseWebhook({}, body)).toBeNull();
  });
});
