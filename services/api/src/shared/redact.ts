/**
 * What never goes into logs or error reports: credentials, signatures, keys and personal data.
 * Logs drop these by path (pino `redact`, below).
 */

/** Request headers that carry credentials. */
export const SECRET_HEADERS = [
  'authorization',
  'cookie',
  'set-cookie',
  'x-ops-token',
  'x-callback-token',
  'moonpay-signature-v2',
] as const;

/** Body and log fields holding signatures, keys, tokens, or personal data. */
export const SECRET_FIELDS = [
  'signature',
  'qrPayload',
  'fcmToken',
  'publicKey',
  'displayName',
  'challenge',
  'token',
  'accessToken',
  'password',
  'secret',
  'secretKey',
  'privateKey',
  'private_key',
  'apiKey',
  'webhookKey',
  'callbackToken',
  'accountNumber',
  'accountHolderName',
  'email',
] as const;

const SECRET_NAMES: readonly string[] = [...SECRET_HEADERS, ...SECRET_FIELDS];

/**
 * pino `redact` paths: each secret name at the top of a log object and two levels down, which covers
 * `{ headers }`, `{ body }`, `{ req: { headers } }` and `{ request: { body } }`. (pino paths can't say "any depth";
 * errors are scrubbed in full instead.)
 */
export const LOG_REDACT_PATHS: readonly string[] = SECRET_NAMES.flatMap((name) => {
  const key = /^[A-Za-z_$][\w$]*$/.test(name) ? `.${name}` : `["${name}"]`;
  return [key.startsWith('.') ? name : key, `*${key}`, `*.*${key}`];
});

export const REDACTED = '[Redacted]';
