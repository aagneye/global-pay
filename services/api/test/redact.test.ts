import { EventEmitter } from 'node:events';
import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { buildPromptPayQr } from '../src/lib/promptpay/build.js';
import { installCrashHandlers, loggerOptions } from '../src/shared/logging.js';
import { isSecretKey, scrub, scrubError, scrubText } from '../src/shared/redact.js';
import { ANVIL } from './support/anvil.js';

const KEY = ANVIL.accounts.payer.privateKey;
const SIGNATURE = `0x${'5a'.repeat(65)}`;
const ADDRESS = ANVIL.accounts.payer.address;
const JWT = 'eyJhbGciOiJIUzI1NiJ9.eyJ3YWxsZXQiOiIweDE1ZDMifQ.c2lnbmF0dXJlLW9mLXRoZS10b2tlbg';
const QR = buildPromptPayQr({ kind: 'personal', targetType: 'mobile', targetId: '0066812345678', amount: { currency: 'THB', minor: 50_00n } });

describe('scrub', () => {
  it('redacts secret fields at any depth, in any spelling', () => {
    const scrubbed = scrub({
      paymentId: 'pay_1',
      amount: 1_000_000n,
      payer: ADDRESS,
      request: { headers: { Authorization: 'Bearer x', 'X-Ops-Token': 'ops', 'user-agent': 'app' }, body: { qrPayload: QR, signature: SIGNATURE } },
      deep: { a: { b: { c: { privateKey: KEY, fcm_token: 'fcm', clientSecret: 's', displayName: 'Somchai' } } } },
      env: { QUOTE_SIGNER_PRIVATE_KEY: KEY, JWT_SECRET: 'j', OPS_API_TOKEN: 'o', XENDIT_CALLBACK_TOKEN: 'x', MOONPAY_WEBHOOK_KEY: 'w' },
    });
    expect(scrubbed).toEqual({
      paymentId: 'pay_1',
      amount: '1000000',
      payer: ADDRESS,
      request: { headers: { Authorization: '[Redacted]', 'X-Ops-Token': '[Redacted]', 'user-agent': 'app' }, body: { qrPayload: '[Redacted]', signature: '[Redacted]' } },
      deep: { a: { b: { c: { privateKey: '[Redacted]', fcm_token: '[Redacted]', clientSecret: '[Redacted]', displayName: '[Redacted]' } } } },
      env: { QUOTE_SIGNER_PRIVATE_KEY: '[Redacted]', JWT_SECRET: '[Redacted]', OPS_API_TOKEN: '[Redacted]', XENDIT_CALLBACK_TOKEN: '[Redacted]', MOONPAY_WEBHOOK_KEY: '[Redacted]' },
    });
    expect(['tokenAmount', 'txHash', 'quoteId', 'status'].some(isSecretKey)).toBe(false);
  });

  it('scrubs keys, signatures, tokens, QR payloads and URL credentials out of text', () => {
    const text = scrubText(
      `signed by ${KEY} with ${SIGNATURE} (bare ${KEY.slice(2)}) for ${ADDRESS}; token ${JWT}; ` +
        `Authorization: Bearer abc.def; qr ${QR}; rpc https://base-sepolia.g.alchemy.com/v2/AbCdEfGhIjKlMnOpQrStUv01 ` +
        `db postgresql://globalpay:hunter2@db:5432/app url https://api.example.com/rates?apiKey=k123&pair=USDC-THB`,
    );
    for (const secret of [KEY, KEY.slice(2), SIGNATURE, JWT, 'abc.def', QR, 'AbCdEfGhIjKlMnOpQrStUv01', 'hunter2', 'k123']) {
      expect(text).not.toContain(secret);
    }
    expect(text).toContain(ADDRESS); // 20-byte addresses stay: they're needed to follow a payment
    expect(text).toContain('Bearer [Redacted]');
    expect(text).toContain('[Redacted qr]');
    expect(text).toContain('pair=USDC-THB');
    expect(text).toContain('https://base-sepolia.g.alchemy.com/v2/[Redacted]');
  });

  it('turns errors into plain objects, scrubbing the message, stack, fields and causes', () => {
    const cause = Object.assign(new Error(`relay failed for ${SIGNATURE}`), { body: { signature: SIGNATURE, quoteId: 'q1' } });
    const error = Object.assign(new TypeError(`could not sign with ${KEY}`, { cause }), { code: 'E_SIGN', headers: { cookie: 'c' } });
    const scrubbed = scrubError(error) as Record<string, any>;

    expect(scrubbed.type).toBe('TypeError');
    expect(scrubbed.message).toBe('could not sign with [Redacted hex]');
    expect(scrubbed.stack).toContain('TypeError: could not sign with [Redacted hex]');
    expect(scrubbed.code).toBe('E_SIGN');
    expect(scrubbed.headers).toEqual({ cookie: '[Redacted]' });
    expect(scrubbed.cause).toMatchObject({ type: 'Error', message: 'relay failed for [Redacted hex]', body: { signature: '[Redacted]', quoteId: 'q1' } });
    expect(JSON.stringify(scrubbed)).not.toMatch(/5a5a5a|ac0974|47e179/);

    const aggregate = scrubError(new AggregateError([new Error(KEY)], 'several')) as Record<string, any>;
    expect(aggregate.errors[0].message).toBe('[Redacted hex]');
  });

  it('copes with anything thrown: strings, objects, cycles, deep nesting, bytes and dates', () => {
    expect(scrubError(`boom ${KEY}`)).toEqual({ type: 'string', message: 'boom [Redacted hex]', stack: '' });
    expect(scrubError({ reason: 'x', secret: 's' })).toEqual({ type: 'Object', message: '', stack: '', reason: 'x', secret: '[Redacted]' });
    const cyclic: Record<string, unknown> = { name: 'loop' };
    cyclic.self = cyclic;
    expect(scrub(cyclic)).toEqual({ name: 'loop', self: '[Circular]' });
    let deep: Record<string, unknown> = { end: true };
    for (let i = 0; i < 20; i++) deep = { next: deep };
    expect(JSON.stringify(scrub(deep))).toContain('[Truncated]');
    expect(scrub({ at: new Date(0), raw: Buffer.from('secret bytes'), fn: () => 1 })).toEqual({ at: '1970-01-01T00:00:00.000Z', raw: '[12 bytes]', fn: undefined });
  });
});

/** The app's logger writing JSON lines into an array. */
function captureLogger() {
  const lines: string[] = [];
  const app = Fastify({ logger: loggerOptions({ stream: { write: (line: string) => void lines.push(line) } }) });
  return { log: app.log, text: () => lines.join(''), entries: () => lines.map((line) => JSON.parse(line) as Record<string, any>) };
}

describe('the app logger', () => {
  it('scrubs errors and messages, however they are logged', () => {
    const { log, text, entries } = captureLogger();
    log.error(new Error(`signature ${SIGNATURE} rejected`));
    log.error({ err: new Error(`key ${KEY}`) });
    log.warn({ err: new Error('relay failed'), quoteId: 'q1' }, `retrying with ${JWT}`);
    log.info('header was Bearer %s', 'abc.def');

    expect(text()).not.toMatch(/5a5a5a|ac0974|47e179|eyJhbGci|abc\.def/);
    const [first, second, third] = entries();
    expect(first).toMatchObject({ level: 50, msg: 'signature [Redacted hex] rejected', err: { type: 'Error', message: 'signature [Redacted hex] rejected' } });
    expect(second).toMatchObject({ msg: 'key [Redacted hex]' });
    expect(third).toMatchObject({ msg: 'retrying with [Redacted jwt]', quoteId: 'q1', err: { message: 'relay failed' } });
  });
});

describe('crash handlers', () => {
  it('log an uncaught exception, scrubbed, and exit 1', () => {
    const { log, text, entries } = captureLogger();
    const exits: number[] = [];
    const proc = new EventEmitter();
    installCrashHandlers(log, (code) => exits.push(code), proc);

    proc.emit('uncaughtException', Object.assign(new Error(`cannot use ${KEY}`), { privateKey: KEY }), 'uncaughtException');
    expect(exits).toEqual([1]);
    expect(entries()[0]).toMatchObject({ level: 60, msg: 'uncaught exception; exiting', err: { message: 'cannot use [Redacted hex]', privateKey: '[Redacted]' } });
    expect(text()).not.toContain(KEY.slice(2));
  });

  it('log an unhandled rejection, scrubbed, and keep running', () => {
    const { log, entries } = captureLogger();
    const exits: number[] = [];
    const proc = new EventEmitter();
    installCrashHandlers(log, (code) => exits.push(code), proc);

    proc.emit('unhandledRejection', new Error(`push failed for ${JWT}`));
    expect(exits).toEqual([]);
    expect(entries()[0]).toMatchObject({ level: 50, msg: 'unhandled promise rejection', err: { message: 'push failed for [Redacted jwt]' } });
  });
});
