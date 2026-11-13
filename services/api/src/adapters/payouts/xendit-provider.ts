import { timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { FIAT_DECIMALS, type FiatAmount, formatMinor, parseDecimal } from '../../domain/money.js';
import type { PromptPayQr } from '../../domain/promptpay.js';
import type {
  PayoutProvider,
  PayoutRequest,
  PayoutResult,
  PayoutWebhookRef,
} from '../../ports/payout-provider.js';
import { AppError } from '../../shared/errors.js';

/** Where to send a payout, in Xendit's terms. */
export interface XenditDestination {
  channelCode: string;
  accountNumber: string;
  accountHolderName: string;
}

export interface XenditPayoutOptions {
  secretKey: string;
  /** The static token Xendit sends in `x-callback-token` with every webhook. */
  callbackToken?: string;
  /**
   * Xendit's THB channel for PromptPay IDs (check `GET /payouts_channels?currency=THB`). When set, personal
   * (tag 29) QRs are paid to their PromptPay ID through it. Which ID types it accepts isn't documented: confirm
   * with Xendit before relying on it. Bill-payment (tag 30) QRs aren't supported.
   */
  promptPayChannelCode?: string;
  /** Sandbox only: fixed destinations by PromptPay target ID, e.g. Xendit's test bank accounts. */
  testDestinations?: Record<string, XenditDestination>;
  baseUrl?: string;
  timeoutMs?: number;
  /** How long a balance answer is reused. */
  balanceCacheMs?: number;
  fetch?: typeof fetch;
  now?: () => number;
}

const PayoutSchema = z.looseObject({
  id: z.string(),
  reference_id: z.string().optional(),
  status: z.string(),
  failure_code: z.string().nullish(),
  processor_reference: z.string().nullish(),
  connector_reference: z.string().nullish(),
});
type XenditPayout = z.infer<typeof PayoutSchema>;

const PayoutListSchema = z.union([z.array(PayoutSchema), z.looseObject({ data: z.array(PayoutSchema) })]);

/**
 * Xendit payouts (API v2), for the sandbox. https://docs.xendit.co/docs/payouts-thailand
 *
 * - Every create carries `Idempotency-key`: the same key and body returns the original payout.
 * - A timeout or 5xx on create may or may not have created the payout, so it's `unknown`; the worker then
 *   looks it up by our reference before trying again.
 * - SUCCEEDED can later become REVERSED.
 */
export class XenditPayoutProvider implements PayoutProvider {
  readonly name = 'xendit';
  private readonly options: XenditPayoutOptions;
  private readonly baseUrl: string;
  private readonly fetch: typeof fetch;
  private readonly now: () => number;
  private balance?: { value: FiatAmount; at: number };

  constructor(options: XenditPayoutOptions) {
    this.options = options;
    this.baseUrl = (options.baseUrl ?? 'https://api.xendit.co').replace(/\/$/, '');
    this.fetch = options.fetch ?? globalThis.fetch;
    this.now = options.now ?? Date.now;
  }

  supports(merchant: PromptPayQr): boolean {
    return this.destinationFor(merchant) !== null;
  }

  async createPayout(request: PayoutRequest): Promise<PayoutResult> {
    const destination = this.destinationFor(request.merchant);
    if (!destination) {
      return { status: 'failed', reason: 'This payout rail cannot pay this QR type', providerStatus: 'UNSUPPORTED' };
    }
    if (request.amount.currency !== 'THB') {
      return { status: 'failed', reason: 'Only THB payouts are supported', providerStatus: 'UNSUPPORTED' };
    }

    let response: Response;
    try {
      response = await this.request('POST', '/v2/payouts', {
        headers: { 'Idempotency-key': request.idempotencyKey },
        body: {
          reference_id: request.idempotencyKey,
          channel_code: destination.channelCode,
          channel_properties: {
            account_holder_name: destination.accountHolderName,
            account_number: destination.accountNumber,
          },
          amount: Number(formatMinor(request.amount.minor, FIAT_DECIMALS.THB)),
          currency: 'THB',
          description: `GlobalPay ${request.paymentId}`,
        },
      });
    } catch (error) {
      // The request may have reached Xendit: we can't tell.
      return { status: 'unknown', reason: `Create call failed: ${(error as Error).message}` };
    }

    const body = await readJson(response);
    if (response.ok) return toResult(PayoutSchema.parse(body), body);

    const errorCode = typeof body === 'object' && body !== null ? (body as { error_code?: string }).error_code : undefined;
    if (response.status >= 500) {
      return { status: 'unknown', reason: `Xendit answered ${response.status}`, raw: body };
    }
    if (errorCode === 'DUPLICATE_ERROR' || response.status === 409) {
      // Same key, different request: something changed between attempts. A person must look.
      return { status: 'unknown', reason: 'Idempotency key reused with a different request', raw: body };
    }
    if (response.status === 401 || response.status === 403 || response.status === 429) {
      // Our credentials or rate: nothing was created, but this isn't the merchant's failure. Retry later.
      throw new AppError('payout_partner_error', `Xendit refused the request (${response.status} ${errorCode ?? ''})`, 503);
    }
    // Validation errors (400, 404, 422): Xendit rejected it, so no payout exists.
    return {
      status: 'failed',
      reason: `Xendit rejected the payout: ${errorCode ?? response.status}`,
      providerStatus: errorCode ?? String(response.status),
      raw: body,
    };
  }

  async getPayout(providerRef: string): Promise<PayoutResult> {
    const response = await this.request('GET', `/v2/payouts/${encodeURIComponent(providerRef)}`);
    const body = await readJson(response);
    if (response.status === 404) {
      return { status: 'unknown', providerRef, reason: 'Xendit has no payout with this ID', raw: body };
    }
    if (!response.ok) throw new AppError('payout_partner_error', `Xendit answered ${response.status}`, 503);
    return toResult(PayoutSchema.parse(body), body);
  }

  async findByIdempotencyKey(idempotencyKey: string): Promise<PayoutResult | null> {
    const response = await this.request('GET', `/v2/payouts?reference_id=${encodeURIComponent(idempotencyKey)}`);
    const body = await readJson(response);
    if (response.status === 404) return null;
    if (!response.ok) throw new AppError('payout_partner_error', `Xendit answered ${response.status}`, 503);
    const parsed = PayoutListSchema.parse(body);
    const payouts = Array.isArray(parsed) ? parsed : parsed.data;
    const [payout] = payouts.filter((p) => p.reference_id === undefined || p.reference_id === idempotencyKey);
    if (payouts.length > 1) {
      return { status: 'unknown', reason: `Xendit has ${payouts.length} payouts for one key`, raw: body };
    }
    return payout ? toResult(payout, payout) : null;
  }

  async getBalance(): Promise<FiatAmount | null> {
    const cacheMs = this.options.balanceCacheMs ?? 30_000;
    if (this.balance && this.now() - this.balance.at < cacheMs) return this.balance.value;
    const response = await this.request('GET', '/balance?account_type=CASH&currency=THB');
    if (!response.ok) throw new AppError('payout_partner_error', `Xendit answered ${response.status}`, 503);
    const { balance } = z.object({ balance: z.number() }).parse(await readJson(response));
    const minor = parseDecimal(balance.toFixed(2), FIAT_DECIMALS.THB) ?? 0n;
    const value = { currency: 'THB' as const, minor };
    this.balance = { value, at: this.now() };
    return value;
  }

  parseWebhook(headers: Record<string, string | string[] | undefined>, body: unknown): PayoutWebhookRef | null {
    const expected = this.options.callbackToken;
    const received = headers['x-callback-token'];
    if (!expected || typeof received !== 'string' || !constantTimeEqual(received, expected)) return null;
    // Payouts webhooks send { event, data: {...} }; accept a bare payout too.
    const data = (typeof body === 'object' && body !== null && 'data' in body ? (body as { data: unknown }).data : body) as
      | { id?: unknown; reference_id?: unknown }
      | undefined;
    const ref: PayoutWebhookRef = {};
    if (typeof data?.id === 'string') ref.providerRef = data.id;
    if (typeof data?.reference_id === 'string') ref.idempotencyKey = data.reference_id;
    return ref.providerRef || ref.idempotencyKey ? ref : null;
  }

  private destinationFor(merchant: PromptPayQr): XenditDestination | null {
    const test = this.options.testDestinations?.[merchant.targetId];
    if (test) return test;
    if (merchant.kind === 'personal' && this.options.promptPayChannelCode) {
      return {
        channelCode: this.options.promptPayChannelCode,
        accountNumber: merchant.targetId,
        accountHolderName: merchant.merchantName ?? 'PromptPay recipient',
      };
    }
    return null;
  }

  private request(
    method: 'GET' | 'POST',
    path: string,
    init: { headers?: Record<string, string>; body?: unknown } = {},
  ): Promise<Response> {
    return this.fetch(`${this.baseUrl}${path}`, {
      method,
      headers: {
        authorization: `Basic ${Buffer.from(`${this.options.secretKey}:`).toString('base64')}`,
        accept: 'application/json',
        ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
        ...init.headers,
      },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
      signal: AbortSignal.timeout(this.options.timeoutMs ?? 15_000),
    });
  }
}

function toResult(payout: XenditPayout, raw: unknown): PayoutResult {
  const base = { providerRef: payout.id, providerStatus: payout.status, raw };
  switch (payout.status) {
    case 'ACCEPTED':
    case 'REQUESTED':
    case 'PENDING':
      return { ...base, status: 'pending' };
    case 'SUCCEEDED': {
      const reference = payout.processor_reference ?? payout.connector_reference ?? payout.id;
      return { ...base, status: 'succeeded', reference };
    }
    case 'FAILED':
    case 'CANCELLED':
      return { ...base, status: 'failed', reason: payout.failure_code ?? `Payout ${payout.status.toLowerCase()}` };
    case 'REVERSED':
      return { ...base, status: 'reversed', reason: payout.failure_code ?? 'Payout reversed' };
    default:
      return { ...base, status: 'unknown', reason: `Unexpected Xendit status ${payout.status}` };
  }
}

async function readJson(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function constantTimeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}
