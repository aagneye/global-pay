import { FIAT_DECIMALS, parseDecimal } from '../../domain/money.js';
import type { PromptPayQr, PromptPayTargetType } from '../../domain/promptpay.js';
import { AppError } from '../../shared/errors.js';
import { crc16, parseTlv, type TlvField } from './emv.js';
import {
  AID,
  COUNTRY_TH,
  INITIATION,
  MERCHANT_TAG,
  PAYLOAD_FORMAT,
  PERSONAL_TARGET_TAGS,
  TAG,
  THB_NUMERIC,
  isValidTargetId,
} from './spec.js';

/** Error codes shared with packages/fixtures/promptpay/vectors.json. */
export type PromptPayErrorCode =
  | 'missing_crc'
  | 'crc_mismatch'
  | 'malformed_tlv'
  | 'not_promptpay'
  | 'unsupported_currency'
  | 'invalid_field';

export class PromptPayParseError extends AppError {
  readonly reason: PromptPayErrorCode;

  constructor(reason: PromptPayErrorCode, message: string) {
    super('invalid_qr', message, 422);
    this.name = 'PromptPayParseError';
    this.reason = reason;
  }
}

const CRC_HEADER = `${TAG.crc}04`;

/**
 * Parse and validate an EMVCo PromptPay payload.
 * Checks run in the order documented in packages/fixtures/README.md, so each bad payload gets one error:
 * 1. CRC present and valid
 * 2. TLV well formed
 * 3. PromptPay tag 29/30, then currency THB (764)
 * 4. Field values (`invalid_field`)
 */
export function parsePromptPayQr(input: string): PromptPayQr {
  const payload = input.trim();

  // 1. CRC: the payload must end with "6304" + 4 hex digits, computed over everything before them.
  if (payload.length < 8 || payload.slice(-8, -4) !== CRC_HEADER) {
    throw new PromptPayParseError('missing_crc', 'QR has no checksum');
  }
  if (payload.slice(-4).toUpperCase() !== crc16(payload.slice(0, -4))) {
    throw new PromptPayParseError('crc_mismatch', 'QR checksum does not match');
  }

  // 2. TLV structure, with the CRC as the last field.
  const fields = parseTlv(payload);
  if (!fields || fields.at(-1)?.tag !== TAG.crc) {
    throw new PromptPayParseError('malformed_tlv', 'QR fields are malformed');
  }
  const top = toMap(fields);
  const personal = top.get(TAG.personal);
  const merchant = top.get(TAG.merchant);
  const personalFields = personal === undefined ? undefined : parseTlv(personal);
  const merchantFields = merchant === undefined ? undefined : parseTlv(merchant);
  if (personalFields === null || merchantFields === null) {
    throw new PromptPayParseError('malformed_tlv', 'QR payee fields are malformed');
  }

  // 3. PromptPay, in THB.
  const personalMap = personalFields && toMap(personalFields);
  const merchantMap = merchantFields && toMap(merchantFields);
  const isPersonal = personalMap?.get('00') === AID.personal;
  const isMerchant = merchantMap?.get('00') === AID.merchant;
  if (!isPersonal && !isMerchant) {
    throw new PromptPayParseError('not_promptpay', 'Not a PromptPay QR');
  }
  if (top.get(TAG.currency) !== THB_NUMERIC) {
    throw new PromptPayParseError('unsupported_currency', 'Only Thai baht (THB) QRs are supported');
  }

  // 4. Field values.
  if (isPersonal && isMerchant) invalid('QR names both a personal and a merchant payee');
  if (top.get(TAG.payloadFormat) !== PAYLOAD_FORMAT) invalid('Unknown QR payload format');
  if (top.get(TAG.country) !== COUNTRY_TH) invalid('QR country must be TH');

  const amount = parseAmount(top.get(TAG.amount));
  const initiation = parseInitiation(top.get(TAG.initiation), amount !== undefined);

  const merchantName = top.get(TAG.merchantName);
  const merchantCity = top.get(TAG.merchantCity);

  const base = {
    raw: payload,
    initiation,
    ...(amount === undefined ? {} : { amount: { currency: 'THB' as const, minor: amount } }),
    ...(merchantName === undefined ? {} : { merchantName }),
    ...(merchantCity === undefined ? {} : { merchantCity }),
  };

  if (isMerchant && merchantMap) {
    const targetId = merchantMap.get(MERCHANT_TAG.billerId);
    if (targetId === undefined || !isValidTargetId('biller', targetId)) invalid('Invalid biller ID');
    const reference1 = merchantMap.get(MERCHANT_TAG.reference1);
    const reference2 = merchantMap.get(MERCHANT_TAG.reference2);
    return {
      ...base,
      kind: 'merchant',
      targetType: 'biller',
      targetId,
      ...(reference1 === undefined ? {} : { reference1 }),
      ...(reference2 === undefined ? {} : { reference2 }),
    };
  }

  const targets = (Object.entries(PERSONAL_TARGET_TAGS) as [PromptPayTargetType, string][])
    .map(([type, tag]) => ({ type, id: personalMap?.get(tag) }))
    .filter((target): target is { type: PromptPayTargetType; id: string } => target.id !== undefined);
  const [target] = targets;
  if (targets.length !== 1 || !target) invalid('QR must name exactly one payee');
  if (!isValidTargetId(target.type, target.id)) invalid(`Invalid ${target.type} ID`);
  return { ...base, kind: 'personal', targetType: target.type, targetId: target.id };
}

function toMap(fields: TlvField[]): Map<string, string> {
  return new Map(fields.map((field) => [field.tag, field.value]));
}

function invalid(message: string): never {
  throw new PromptPayParseError('invalid_field', message);
}

/** Tag 54: a positive decimal with at most 2 fraction digits ("100", "59.5", "250.00"). */
function parseAmount(value: string | undefined): bigint | undefined {
  if (value === undefined) return undefined;
  const minor = parseDecimal(value, FIAT_DECIMALS.THB);
  if (minor === null || minor <= 0n) invalid('Invalid QR amount');
  return minor;
}

/** Tag 01: "11" static or "12" dynamic. If it's missing, a QR with an amount counts as dynamic. */
function parseInitiation(value: string | undefined, hasAmount: boolean): PromptPayQr['initiation'] {
  if (value === undefined) return hasAmount ? 'dynamic' : 'static';
  if (value === INITIATION.static) return 'static';
  if (value === INITIATION.dynamic) return 'dynamic';
  return invalid('Unknown QR initiation method');
}
