/**
 * What never goes into logs or error reports: credentials, signatures, keys and personal data.
 * Log entries drop these by path (pino `redact`); errors and log messages are scrubbed in full (`scrub`).
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

export const REDACTED = '[Redacted]';

/**
 * pino `redact` paths: each secret name at the top of a log entry and two levels down, which covers
 * `{ headers }`, `{ body }`, `{ req: { headers } }` and `{ request: { body } }`. (pino paths can't say "any depth";
 * errors are scrubbed in full instead.)
 */
export const LOG_REDACT_PATHS: readonly string[] = SECRET_NAMES.flatMap((name) => {
  const key = /^[A-Za-z_$][\w$]*$/.test(name) ? `.${name}` : `["${name}"]`;
  return [key.startsWith('.') ? name : key, `*${key}`, `*.*${key}`];
});

const normalize = (key: string) => key.toLowerCase().replace(/[^a-z0-9]/g, '');
const SECRET_KEYS = new Set(SECRET_NAMES.map(normalize));

/** A key whose value is never reported: the names above in any case or spelling, and anything like a key, secret or token. */
export function isSecretKey(key: string): boolean {
  const name = normalize(key);
  return SECRET_KEYS.has(name) || /privatekey|secret|password|apikey|webhookkey|signature|authorization|cookie/.test(name) || name.endsWith('token');
}

/** Values inside text that look like credentials or personal data. */
const TEXT_RULES: readonly [RegExp, string][] = [
  // PromptPay (EMVCo) QR payloads name a phone number or national ID: from the header to the CRC.
  // First, because their digits would otherwise pass for hex.
  [/000201[\s\S]*?6304[0-9A-Fa-f]{4}/g, '[Redacted qr]'],
  // Private keys, signatures, calldata and hashes: 32 bytes of hex or more.
  [/\b(?:0x)?[0-9a-fA-F]{64,}\b/g, '[Redacted hex]'],
  [/\beyJ[\w-]*\.[\w-]+\.[\w-]+/g, '[Redacted jwt]'],
  [/\b(Bearer|Basic)\s+[^\s"',]+/gi, `$1 ${REDACTED}`],
  // Credentials in URLs (an RPC provider's key, say): user:password@, ?key=…, and /v2/<key> paths.
  [/(\b[a-z][a-z0-9+.-]*:\/\/)[^\s/@"']+@/gi, `$1${REDACTED}@`],
  [/([?&](?:api[_-]?key|key|token|secret|access[_-]?token|signature)=)[^&\s"']+/gi, `$1${REDACTED}`],
  [/(\/v\d+\/)[A-Za-z0-9_-]{20,}/g, `$1${REDACTED}`],
];

/** Text with credential-looking values replaced. */
export function scrubText(text: string): string {
  return TEXT_RULES.reduce((result, [pattern, replacement]) => result.replace(pattern, replacement), text);
}

/** An error as logged: what pino's error serializer produces, scrubbed. */
export interface ScrubbedError {
  type: string;
  message: string;
  stack: string;
  [key: string]: unknown;
}

/** Anything thrown, as a scrubbed plain object: the logger's `err` serializer. */
export function scrubError(error: unknown): ScrubbedError {
  const value = scrub(error);
  if (error instanceof Error) {
    const scrubbed = value as { type: string; message: string; stack?: string };
    return { ...scrubbed, stack: scrubbed.stack ?? '' };
  }
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) return { type: 'Object', message: '', stack: '', ...value };
  return { type: typeof error, message: String(value), stack: '' };
}

const MAX_DEPTH = 8;

/**
 * A copy of `value` that's safe to log or report: secret keys redacted at any depth, text scrubbed, errors
 * turned into plain objects (type, message, stack, own fields, cause), cycles and deep nesting cut.
 */
export function scrub(value: unknown): unknown {
  return scrubValue(value, 0, new WeakSet());
}

function scrubValue(value: unknown, depth: number, seen: WeakSet<object>): unknown {
  if (typeof value === 'string') return scrubText(value);
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'function' || typeof value === 'symbol') return undefined;
  if (value === null || typeof value !== 'object') return value;
  if (value instanceof Date) return value.toISOString();
  if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer) return `[${value.byteLength} bytes]`;
  if (seen.has(value)) return '[Circular]';
  if (depth >= MAX_DEPTH) return '[Truncated]';
  seen.add(value);

  if (Array.isArray(value)) return value.map((item) => scrubValue(item, depth + 1, seen));
  const out: Record<string, unknown> = {};
  if (value instanceof Error) {
    out.type = value.constructor?.name ?? value.name;
    out.message = scrubText(value.message);
    if (value.stack) out.stack = scrubText(value.stack);
  }
  for (const [key, item] of Object.entries(value)) {
    out[key] = isSecretKey(key) ? REDACTED : scrubValue(item, depth + 1, seen);
  }
  if (value instanceof Error) {
    // Not enumerable, so not copied above.
    if (value.cause !== undefined) out.cause = scrubValue(value.cause, depth + 1, seen);
    if (value instanceof AggregateError) out.errors = scrubValue(value.errors, depth + 1, seen);
  }
  return out;
}
