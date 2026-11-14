import { generateKeyPairSync, verify } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { FcmPushSender } from '../src/adapters/push/fcm-push-sender.js';

const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const account = {
  project_id: 'globalpay-test',
  client_email: 'push@globalpay-test.iam.gserviceaccount.com',
  private_key: privateKey.export({ format: 'pem', type: 'pkcs8' }).toString(),
};
const message = { title: 'Payment request', body: 'Open GlobalPay to review it', data: { type: 'p2p_request', requestId: 'request_1' } };

function fcm(answer: (url: string) => Response) {
  const calls: { url: string; init: RequestInit }[] = [];
  let now = 1_800_000_000_000;
  const sender = new FcmPushSender({
    account,
    now: () => now,
    fetch: async (url, init) => {
      calls.push({ url: String(url), init: init ?? {} });
      if (String(url) === 'https://oauth2.googleapis.com/token') return new Response(JSON.stringify({ access_token: 'ya29.token', expires_in: 3600 }));
      return answer(String(url));
    },
  });
  return { sender, calls, later: (ms: number) => (now += ms) };
}

describe('FcmPushSender', () => {
  it('gets an access token with a signed service-account JWT, then sends a high-priority message', async () => {
    const { sender, calls } = fcm(() => new Response('{}'));
    await expect(sender.send('device-token', message)).resolves.toBe('sent');

    const assertion = new URLSearchParams(String(calls[0]?.init.body)).get('assertion')!;
    const [header, claims, signature] = assertion.split('.');
    expect(verify('RSA-SHA256', Buffer.from(`${header}.${claims}`), publicKey, Buffer.from(signature!, 'base64url'))).toBe(true);
    expect(JSON.parse(Buffer.from(claims!, 'base64url').toString())).toMatchObject({
      iss: account.client_email,
      scope: 'https://www.googleapis.com/auth/firebase.messaging',
      aud: 'https://oauth2.googleapis.com/token',
    });

    expect(calls[1]?.url).toBe('https://fcm.googleapis.com/v1/projects/globalpay-test/messages:send');
    expect((calls[1]?.init.headers as Record<string, string>).authorization).toBe('Bearer ya29.token');
    expect(JSON.parse(String(calls[1]?.init.body))).toEqual({
      message: { token: 'device-token', notification: { title: message.title, body: message.body }, data: message.data, android: { priority: 'high' } },
    });
  });

  it('reuses the access token until shortly before it expires', async () => {
    const { sender, calls, later } = fcm(() => new Response('{}'));
    await sender.send('a', message);
    await sender.send('b', message);
    expect(calls.filter((c) => c.url.includes('oauth2'))).toHaveLength(1);
    later(3_590_000);
    await sender.send('c', message);
    expect(calls.filter((c) => c.url.includes('oauth2'))).toHaveLength(2);
  });

  it('reports a stale token as unregistered, and throws on other errors', async () => {
    const stale = fcm(() => new Response(JSON.stringify({ error: { status: 'NOT_FOUND', details: [{ errorCode: 'UNREGISTERED' }] } }), { status: 404 }));
    await expect(stale.sender.send('old', message)).resolves.toBe('unregistered');

    const down = fcm(() => new Response(JSON.stringify({ error: { status: 'UNAVAILABLE' } }), { status: 503 }));
    await expect(down.sender.send('x', message)).rejects.toThrow(/503 UNAVAILABLE/);
  });
});
