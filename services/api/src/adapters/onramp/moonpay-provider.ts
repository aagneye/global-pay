import { createHmac, timingSafeEqual } from 'node:crypto';
import { type Address, type Hex, getAddress, isAddress } from 'viem';
import { FIAT_DECIMALS, formatMinor, parseDecimal } from '../../domain/money.js';
import type { OnrampCheckout, OnrampProvider, OnrampResult, OnrampWebhookRef } from '../../ports/onramp-provider.js';
import { AppError } from '../../shared/errors.js';

export interface MoonPayOptions {
  /** pk_test_… (sandbox) or pk_live_…: sent in the widget URL and on reads. */
  publishableKey: string;
  /** sk_test_… or sk_live_…: signs the widget URL. Never sent anywhere. */
  secretKey: string;
  /** The webhook key from MoonPay's dashboard; without it, webhooks are refused. */
  webhookKey?: string;
  /** https://buy-sandbox.moonpay.com (sandbox) or https://buy.moonpay.com. */
  widgetUrl?: string;
  apiUrl?: string;
  /** MoonPay's code for the token, e.g. usdc_base. */
  currencyCode?: string;
  tokenDecimals?: number;
  /** Where the widget sends the user afterwards (an https link back to the app). */
  redirectUrl?: string;
  /** Webhooks older or newer than this are refused as replays. */
  webhookToleranceMs?: number;
  timeoutMs?: number;
  fetch?: typeof globalThis.fetch;
}

/** MoonPay's buy transaction, as far as we use it. */
interface MoonPayTransaction {
  id: string;
  status: string;
  createdAt?: string;
  walletAddress?: string | null;
  quoteCurrencyAmount?: number | string | null;
  cryptoTransactionId?: string | null;
  failureReason?: string | null;
  externalTransactionId?: string | null;
}

const STATUS: Record<string, OnrampResult['status']> = {
  waitingPayment: 'waiting',
  waitingAuthorization: 'pending',
  pending: 'pending',
  completed: 'completed',
  failed: 'failed',
};

/**
 * MoonPay on-ramp (https://dev.moonpay.com). The widget URL is signed with the secret key, because it
 * carries the wallet address. Webhooks are checked with Moonpay-Signature-V2 over the raw body, then the
 * purchase is fetched again by our order ID: webhooks can arrive more than once and out of order.
 */
export class MoonPayOnrampProvider implements OnrampProvider {
  readonly name = 'moonpay';
  private readonly options: Required<Omit<MoonPayOptions, 'webhookKey' | 'redirectUrl'>> &
    Pick<MoonPayOptions, 'webhookKey' | 'redirectUrl'>;

  constructor(options: MoonPayOptions) {
    this.options = {
      widgetUrl: 'https://buy-sandbox.moonpay.com',
      apiUrl: 'https://api.moonpay.com',
      currencyCode: 'usdc_base',
      tokenDecimals: 6,
      webhookToleranceMs: 5 * 60_000,
      timeoutMs: 15_000,
      fetch: globalThis.fetch,
      ...options,
    };
  }

  checkoutUrl({ orderId, walletAddress, fiat }: OnrampCheckout): string {
    const { publishableKey, secretKey, widgetUrl, currencyCode, redirectUrl } = this.options;
    const params = new URLSearchParams({
      apiKey: publishableKey,
      currencyCode,
      walletAddress,
      baseCurrencyCode: fiat.currency.toLowerCase(),
      baseCurrencyAmount: formatMinor(fiat.minor, FIAT_DECIMALS[fiat.currency]),
      externalTransactionId: orderId,
      ...(redirectUrl ? { redirectURL: redirectUrl } : {}),
    });
    const unsigned = `${widgetUrl.replace(/\/$/, '')}?${params.toString()}`;
    // MoonPay signs the query string, including the "?", and wants the signature last.
    const signature = createHmac('sha256', secretKey).update(new URL(unsigned).search).digest('base64');
    return `${unsigned}&signature=${encodeURIComponent(signature)}`;
  }

  async findByOrderId(orderId: string): Promise<OnrampResult | null> {
    const { apiUrl, publishableKey, timeoutMs, fetch } = this.options;
    const url = `${apiUrl}/v1/transactions/ext/${encodeURIComponent(orderId)}?apiKey=${encodeURIComponent(publishableKey)}`;
    const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    if (response.status === 404) return null;
    if (response.status === 401 || response.status === 403) {
      throw new AppError('onramp_partner_error', `MoonPay refused our key (HTTP ${response.status})`, 503);
    }
    if (!response.ok) throw new Error(`MoonPay returned HTTP ${response.status}`);
    // Documented as an array (external IDs aren't unique at MoonPay), but sometimes a single object.
    const body = (await response.json()) as MoonPayTransaction | MoonPayTransaction[];
    const transactions = (Array.isArray(body) ? body : [body]).filter((tx) => tx && typeof tx.id === 'string');
    const chosen = pick(transactions);
    return chosen ? this.toResult(chosen) : null;
  }

  parseWebhook(headers: Record<string, string | string[] | undefined>, rawBody: string, now: Date): OnrampWebhookRef | null {
    const { webhookKey, webhookToleranceMs } = this.options;
    const header = headers['moonpay-signature-v2'];
    if (!webhookKey || typeof header !== 'string') return null;
    const parts = Object.fromEntries(header.split(',').map((part) => part.trim().split('=') as [string, string]));
    const timestamp = Number(parts.t);
    const given = parts.s ?? '';
    if (!Number.isFinite(timestamp) || !/^[0-9a-f]{64}$/i.test(given)) return null;

    const expected = createHmac('sha256', webhookKey).update(`${parts.t}.${rawBody}`).digest('hex');
    if (!timingSafeEqual(Buffer.from(expected), Buffer.from(given.toLowerCase()))) return null;
    // A valid signature on an old message is a replay.
    if (Math.abs(now.getTime() - timestamp * 1000) > webhookToleranceMs) return null;

    try {
      const body = JSON.parse(rawBody) as { data?: MoonPayTransaction };
      const orderId = body.data?.externalTransactionId ?? undefined;
      return orderId ? { orderId } : {};
    } catch {
      return {};
    }
  }

  private toResult(tx: MoonPayTransaction): OnrampResult {
    const amount =
      tx.quoteCurrencyAmount === null || tx.quoteCurrencyAmount === undefined
        ? null
        : parseDecimal(String(tx.quoteCurrencyAmount), this.options.tokenDecimals, { truncate: true });
    return {
      status: STATUS[tx.status] ?? 'pending',
      providerTxId: tx.id,
      providerStatus: tx.status,
      ...(tx.walletAddress && isAddress(tx.walletAddress) ? { walletAddress: getAddress(tx.walletAddress) as Address } : {}),
      ...(amount !== null && amount > 0n ? { tokenAmount: amount } : {}),
      ...(tx.cryptoTransactionId && /^0x[0-9a-fA-F]{64}$/.test(tx.cryptoTransactionId) ? { txHash: tx.cryptoTransactionId as Hex } : {}),
      ...(tx.status === 'failed' ? { failureReason: tx.failureReason ?? 'MoonPay reported the purchase as failed' } : {}),
      raw: tx,
    };
  }
}

/** Of several purchases for one order (the user retried in the widget), the one that matters. */
function pick(transactions: MoonPayTransaction[]): MoonPayTransaction | undefined {
  const completed = transactions.find((tx) => tx.status === 'completed');
  if (completed) return completed;
  return [...transactions].sort((a, b) => Date.parse(b.createdAt ?? '') - Date.parse(a.createdAt ?? ''))[0];
}
