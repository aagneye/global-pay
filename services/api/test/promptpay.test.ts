import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { formatMinor } from '../src/domain/money.js';
import { type BuildPromptPayQrInput, buildPromptPayQr } from '../src/lib/promptpay/build.js';
import { crc16, encodeTlv, parseTlv } from '../src/lib/promptpay/emv.js';
import { merchantRef, merchantRefHash } from '../src/lib/promptpay/merchant-ref.js';
import { PromptPayParseError, parsePromptPayQr } from '../src/lib/promptpay/parse.js';

interface ValidVector {
  name: string;
  payload: string;
  expected: {
    initiation: 'static' | 'dynamic';
    kind: 'personal' | 'merchant';
    targetType: 'mobile' | 'nationalId' | 'eWallet' | 'biller';
    targetId: string;
    reference1?: string;
    reference2?: string;
    amount: string | null;
    currency: string;
    country: string;
    merchantName?: string;
    merchantCity?: string;
  };
}

interface InvalidVector {
  name: string;
  payload: string;
  error: string;
}

const vectors = JSON.parse(
  readFileSync(new URL('../../../packages/fixtures/promptpay/vectors.json', import.meta.url), 'utf8'),
) as { valid: ValidVector[]; invalid: InvalidVector[] };

function parseError(payload: string): PromptPayParseError {
  try {
    parsePromptPayQr(payload);
  } catch (error) {
    if (error instanceof PromptPayParseError) return error;
    throw error;
  }
  throw new Error('expected the payload to be rejected');
}

/** Rebuilds a payload with a correct CRC, so a test reaches the check it targets. */
function withCrc(body: string): string {
  return `${body}6304${crc16(`${body}6304`)}`;
}

describe('PromptPay parser: shared vectors', () => {
  it.each(vectors.valid.map((vector) => [vector.name, vector] as const))('parses %s', (_name, vector) => {
    const qr = parsePromptPayQr(vector.payload);
    const { expected } = vector;

    expect(qr.raw).toBe(vector.payload);
    expect(qr.initiation).toBe(expected.initiation);
    expect(qr.kind).toBe(expected.kind);
    expect(qr.targetType).toBe(expected.targetType);
    expect(qr.targetId).toBe(expected.targetId);
    expect(qr.reference1).toBe(expected.reference1);
    expect(qr.reference2).toBe(expected.reference2);
    expect(qr.merchantName).toBe(expected.merchantName);
    expect(qr.merchantCity).toBe(expected.merchantCity);
    expect(qr.amount === undefined ? null : formatMinor(qr.amount.minor, 2)).toBe(expected.amount);
    expect(qr.amount?.currency ?? 'THB').toBe('THB');
  });

  it.each(vectors.invalid.map((vector) => [vector.name, vector] as const))('rejects %s', (_name, vector) => {
    const error = parseError(vector.payload);
    expect(error.reason).toBe(vector.error);
    expect(error.statusCode).toBe(422);
    expect(error.code).toBe('invalid_qr');
  });
});

describe('PromptPay parser: edge cases', () => {
  const mobile = '29370016A00000067701011101130066812345678';

  it('accepts surrounding whitespace and a lowercase CRC', () => {
    const payload = withCrc(`000201010212${mobile}53037645406100.005802TH`);
    const lower = payload.slice(0, -4) + payload.slice(-4).toLowerCase();
    expect(parsePromptPayQr(`  ${lower}\n`).amount?.minor).toBe(10_000n);
  });

  it('accepts amounts with fewer than two decimals', () => {
    expect(parsePromptPayQr(withCrc(`000201010212${mobile}5303764540459.55802TH`)).amount?.minor).toBe(5_950n);
    expect(parsePromptPayQr(withCrc(`000201010212${mobile}53037645402405802TH`)).amount?.minor).toBe(4_000n);
  });

  it('infers initiation from the amount when tag 01 is missing', () => {
    expect(parsePromptPayQr(withCrc(`000201${mobile}5303764540510.005802TH`)).initiation).toBe('dynamic');
    expect(parsePromptPayQr(withCrc(`000201${mobile}53037645802TH`)).initiation).toBe('static');
  });

  it.each([
    ['zero amount', `000201010212${mobile}530376454040.005802TH`],
    ['three decimals', `000201010212${mobile}530376454051.0005802TH`],
    ['unknown initiation', `000201010213${mobile}53037645802TH`],
    ['wrong country', `000201010211${mobile}53037645802US`],
    ['wrong payload format', `000202010211${mobile}53037645802TH`],
    ['short mobile number', `000201010211${'29360016A0000006770101110112006681234567'}53037645802TH`],
    ['two payees', `000201010211${'29540016A000000677010111011300668123456780213' + '1234567890123'}53037645802TH`],
    ['no payee ID', `000201010211${'29200016A000000677010111'}53037645802TH`],
    ['bad biller ID', `000201010211${'30270016A0000006770101120103099'}53037645802TH`],
    [
      'both personal and merchant payees',
      `000201010211${mobile}${'30390016A0000006770101120115099999999999901'}53037645802TH`,
    ],
  ])('rejects %s as invalid_field', (_name, body) => {
    expect(parseError(withCrc(body)).reason).toBe('invalid_field');
  });

  it('rejects a CRC tag that is not the last field', () => {
    // The CRC is valid for the bytes, but "6304" sits inside the merchant name.
    const body = `000201010211${mobile}53037645802TH5904AB63`;
    expect(parseError(`${body}04${crc16(`${body}04`)}`).reason).toBe('malformed_tlv');
  });

  it('rejects a malformed payee template', () => {
    expect(parseError(withCrc('000201010211290500169530376458' + '02TH')).reason).toBe('malformed_tlv');
  });

  it('rejects a repeated tag', () => {
    expect(parseError(withCrc(`000201010211${mobile}530376453037645802TH`)).reason).toBe('malformed_tlv');
  });

  it('rejects a PromptPay template with the wrong application ID', () => {
    expect(parseError(withCrc('00020101021129370016A00000067701019901130066812345678' + '53037645802TH')).reason).toBe(
      'not_promptpay',
    );
  });
});

describe('PromptPay builder', () => {
  function inputFor(vector: ValidVector): BuildPromptPayQrInput {
    const { expected } = vector;
    const amount =
      expected.amount === null
        ? {}
        : { amount: { currency: 'THB' as const, minor: BigInt(expected.amount.replace('.', '')) } };
    const place = {
      ...(expected.merchantName === undefined ? {} : { merchantName: expected.merchantName }),
      ...(expected.merchantCity === undefined ? {} : { merchantCity: expected.merchantCity }),
    };
    if (expected.kind === 'merchant') {
      return {
        kind: 'merchant',
        targetType: 'biller',
        targetId: expected.targetId,
        ...(expected.reference1 === undefined ? {} : { reference1: expected.reference1 }),
        ...(expected.reference2 === undefined ? {} : { reference2: expected.reference2 }),
        ...amount,
        ...place,
      };
    }
    return {
      kind: 'personal',
      targetType: expected.targetType as 'mobile' | 'nationalId' | 'eWallet',
      targetId: expected.targetId,
      ...amount,
      ...place,
    };
  }

  it.each(vectors.valid.map((vector) => [vector.name, vector] as const))(
    'reproduces the %s vector exactly',
    (_name, vector) => {
      expect(buildPromptPayQr(inputFor(vector))).toBe(vector.payload);
    },
  );

  it('round-trips through the parser', () => {
    const payload = buildPromptPayQr({
      kind: 'merchant',
      targetType: 'biller',
      targetId: '099999999999901',
      reference1: 'DEMO0001',
      amount: { currency: 'THB', minor: 12_345n },
      merchantName: 'GLOBALPAY TEST CAFE',
    });
    const qr = parsePromptPayQr(payload);
    expect(qr).toMatchObject({ kind: 'merchant', initiation: 'dynamic', reference1: 'DEMO0001' });
    expect(qr.amount?.minor).toBe(12_345n);
  });

  it('refuses invalid input', () => {
    expect(() => buildPromptPayQr({ kind: 'personal', targetType: 'mobile', targetId: '123' })).toThrow(RangeError);
    expect(() =>
      buildPromptPayQr({
        kind: 'personal',
        targetType: 'mobile',
        targetId: '0066812345678',
        amount: { currency: 'THB', minor: 0n },
      }),
    ).toThrow(RangeError);
  });
});

describe('EMV helpers', () => {
  it('computes the CRC-16/CCITT-FALSE check value', () => {
    expect(crc16('123456789')).toBe('29B1');
  });

  it('encodes and parses TLV fields', () => {
    const data = encodeTlv('00', '01') + encodeTlv('59', 'CAFE');
    expect(data).toBe('0002015904CAFE');
    expect(parseTlv(data)).toEqual([
      { tag: '00', value: '01' },
      { tag: '59', value: 'CAFE' },
    ]);
    expect(parseTlv('0002')).toBeNull();
    expect(parseTlv('0000')).toBeNull();
    expect(parseTlv('AB02xx')).toBeNull();
    expect(() => encodeTlv('00', '')).toThrow(RangeError);
    expect(() => encodeTlv('0', 'x')).toThrow(RangeError);
  });
});

describe('merchant reference', () => {
  it('names the payee and hashes it with keccak256', () => {
    const ref = merchantRef({ targetType: 'biller', targetId: '099999999999901' });
    expect(ref).toBe('promptpay:biller:099999999999901');
    expect(merchantRefHash(ref)).toMatch(/^0x[0-9a-f]{64}$/);
    expect(merchantRefHash(ref)).not.toBe(merchantRefHash('promptpay:biller:099999999999902'));
  });
});
