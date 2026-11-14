import { createSign } from 'node:crypto';
import type { PushMessage, PushSender } from '../../ports/push-sender.js';

/** The fields of a Google service-account key file that FCM needs. */
export interface ServiceAccount {
  project_id: string;
  client_email: string;
  private_key: string;
  token_uri?: string;
}

export interface FcmOptions {
  account: ServiceAccount;
  fetch?: typeof globalThis.fetch;
  now?: () => number;
  timeoutMs?: number;
}

const SCOPE = 'https://www.googleapis.com/auth/firebase.messaging';

/**
 * Firebase Cloud Messaging, HTTP v1 API, with a service-account key: no SDK. It signs a JWT (RS256) for
 * an OAuth access token (cached until shortly before it expires), then posts one message per device.
 * Messages are high priority so they arrive while the app is closed.
 */
export class FcmPushSender implements PushSender {
  readonly name = 'fcm';
  private readonly account: ServiceAccount;
  private readonly fetch: typeof globalThis.fetch;
  private readonly now: () => number;
  private readonly timeoutMs: number;
  private token: { value: string; expiresAt: number } | undefined;

  constructor(options: FcmOptions) {
    this.account = options.account;
    this.fetch = options.fetch ?? globalThis.fetch;
    this.now = options.now ?? Date.now;
    this.timeoutMs = options.timeoutMs ?? 10_000;
  }

  async send(token: string, message: PushMessage): Promise<'sent' | 'unregistered'> {
    const response = await this.fetch(`https://fcm.googleapis.com/v1/projects/${this.account.project_id}/messages:send`, {
      method: 'POST',
      headers: { authorization: `Bearer ${await this.accessToken()}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        message: {
          token,
          notification: { title: message.title, body: message.body },
          data: message.data,
          android: { priority: 'high' },
        },
      }),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (response.ok) return 'sent';
    const body = (await response.json().catch(() => ({}))) as {
      error?: { status?: string; details?: { errorCode?: string }[] };
    };
    const codes = [body.error?.status, ...(body.error?.details ?? []).map((d) => d.errorCode)];
    // A token for an uninstalled app or a rotated token: FCM answers 404 UNREGISTERED (or 400 for a malformed one).
    if (codes.includes('UNREGISTERED') || (response.status === 400 && codes.includes('INVALID_ARGUMENT'))) return 'unregistered';
    if (response.status === 401) this.token = undefined;
    throw new Error(`FCM returned HTTP ${response.status} ${codes.filter(Boolean).join(' ')}`.trim());
  }

  private async accessToken(): Promise<string> {
    const now = this.now();
    if (this.token && now < this.token.expiresAt - 60_000) return this.token.value;

    const tokenUri = this.account.token_uri ?? 'https://oauth2.googleapis.com/token';
    const iat = Math.floor(now / 1000);
    const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url');
    const unsigned = `${encode({ alg: 'RS256', typ: 'JWT' })}.${encode({
      iss: this.account.client_email,
      scope: SCOPE,
      aud: tokenUri,
      iat,
      exp: iat + 3600,
    })}`;
    const signature = createSign('RSA-SHA256').update(unsigned).sign(this.account.private_key).toString('base64url');

    const response = await this.fetch(tokenUri, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${unsigned}.${signature}` }),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!response.ok) throw new Error(`Google OAuth returned HTTP ${response.status}`);
    const { access_token, expires_in } = (await response.json()) as { access_token: string; expires_in: number };
    this.token = { value: access_token, expiresAt: now + expires_in * 1000 };
    return access_token;
  }
}

/** Push isn't configured: nothing is sent, and the apps poll instead. */
export class DisabledPushSender implements PushSender {
  readonly name = 'disabled';
  async send(): Promise<'skipped'> {
    return 'skipped';
  }
}
