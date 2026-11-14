import { afterEach, describe, expect, it } from 'vitest';
import { buildPromptPayQr } from '../src/lib/promptpay/build.js';
import { ANVIL } from './support/anvil.js';
import { type TestApp, buildTestApp, signIn } from './support/app.js';
import { phoneKey } from './support/phone-key.js';

const OPS_TOKEN = 'ops-token-for-tests-0123456789abcdef';

/** Collects what the app logs, one JSON line per entry. */
function captureLogs() {
  const lines: string[] = [];
  return {
    stream: { write: (line: string) => void lines.push(line) },
    text: () => lines.join(''),
    entries: () => lines.map((line) => JSON.parse(line) as Record<string, unknown>),
  };
}

let testApp: TestApp | undefined;
afterEach(async () => {
  await testApp?.app.close();
  testApp = undefined;
});

describe('log redaction', () => {
  it('never writes credentials, signatures or personal data to the logs', async () => {
    const logs = captureLogs();
    testApp = await buildTestApp({ env: { OPS_API_TOKEN: OPS_TOKEN }, logger: { stream: logs.stream, level: 'trace' } });
    const { app } = testApp;
    // A route that logs a request the careless way: headers and body, as they came in.
    app.post('/test/log', async (request) => {
      request.log.info({ headers: request.headers, body: request.body }, 'test: request as received');
      request.log.warn({ request: { headers: request.headers, body: request.body } }, 'test: nested');
      request.log.info(request.body as object, 'test: fields at the top');
      return { ok: true };
    });

    const session = await signIn(app, ANVIL.accounts.payer.privateKey);
    const jwt = session.auth.authorization.slice('Bearer '.length);
    const secrets = {
      signature: `0x${'ab'.repeat(65)}`,
      qrPayload: buildPromptPayQr({ kind: 'personal', targetType: 'mobile', targetId: '0066812345678', amount: { currency: 'THB', minor: 100_00n } }),
      fcmToken: 'fcm-token-that-must-not-leak-1234567890',
      publicKey: phoneKey().publicKey,
      displayName: 'Somchai Jaidee',
      challenge: `0x${'cd'.repeat(32)}`,
      privateKey: ANVIL.accounts.payer.privateKey,
    };
    const headers = {
      ...session.auth,
      'x-ops-token': OPS_TOKEN,
      'x-callback-token': 'xendit-callback-token-secret',
      'moonpay-signature-v2': 't=1700000000,s=moonpay-signature-secret',
      cookie: 'session=cookie-secret-value',
      'user-agent': 'redaction-test',
    };

    expect((await app.inject({ method: 'POST', url: '/test/log', headers, payload: secrets })).statusCode).toBe(200);
    // Real routes that receive these values.
    await app.inject({ method: 'PUT', url: '/me/profile', headers: session.auth, payload: { displayName: secrets.displayName } });
    await app.inject({ method: 'POST', url: '/devices', headers: session.auth, payload: { publicKey: secrets.publicKey, platform: 'android', fcmToken: secrets.fcmToken } });
    await app.inject({ method: 'POST', url: '/quotes', headers: session.auth, payload: { payer: session.address, qrPayload: secrets.qrPayload } });
    await app.inject({ method: 'GET', url: '/ops/api/health', headers: { 'x-ops-token': OPS_TOKEN } });
    await app.inject({ method: 'POST', url: '/webhooks/payouts/simulated', headers: { 'x-callback-token': headers['x-callback-token'] }, payload: {} });

    const text = logs.text();
    for (const value of [jwt, ...Object.values(secrets), OPS_TOKEN, headers['x-callback-token'], headers['moonpay-signature-v2'], headers.cookie]) {
      expect(text).not.toContain(value);
    }

    // The entries were written, with only the secrets taken out.
    const logged = logs.entries().find((entry) => entry.msg === 'test: request as received') as {
      headers: Record<string, string>;
      body: Record<string, string>;
    };
    expect(logged.headers).toMatchObject({ authorization: '[Redacted]', 'x-ops-token': '[Redacted]', cookie: '[Redacted]', 'user-agent': 'redaction-test' });
    expect(logged.body).toMatchObject({ signature: '[Redacted]', qrPayload: '[Redacted]', displayName: '[Redacted]' });
    const nested = logs.entries().find((entry) => entry.msg === 'test: nested') as { request: { headers: Record<string, string> } };
    expect(nested.request.headers['moonpay-signature-v2']).toBe('[Redacted]');
    expect(logs.entries().some((entry) => entry.msg === 'incoming request')).toBe(true);
  });
});
