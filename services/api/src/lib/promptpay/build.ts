import { FIAT_DECIMALS, type FiatAmount, formatMinor } from '../../domain/money.js';
import type { PromptPayTargetType } from '../../domain/promptpay.js';
import { crc16, encodeTlv } from './emv.js';
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

export type BuildPromptPayQrInput =
  | {
      kind: 'personal';
      targetType: Exclude<PromptPayTargetType, 'biller'>;
      targetId: string;
      amount?: FiatAmount;
      merchantName?: string;
      merchantCity?: string;
    }
  | {
      kind: 'merchant';
      targetType: 'biller';
      targetId: string;
      reference1?: string;
      reference2?: string;
      amount?: FiatAmount;
      merchantName?: string;
      merchantCity?: string;
    };

/**
 * Builds an EMVCo PromptPay payload with its CRC. Used for demo QRs and tests.
 * A QR with an amount is dynamic (tag 01 = "12"); without one it's static ("11").
 * Fields are written in tag order, matching packages/fixtures/promptpay/vectors.json.
 */
export function buildPromptPayQr(input: BuildPromptPayQrInput): string {
  if (!isValidTargetId(input.targetType, input.targetId)) {
    throw new RangeError(`Invalid ${input.targetType} ID: ${input.targetId}`);
  }
  if (input.amount && (input.amount.currency !== 'THB' || input.amount.minor <= 0n)) {
    throw new RangeError('Amount must be a positive THB amount');
  }

  const payee =
    input.kind === 'merchant'
      ? encodeTlv('00', AID.merchant) +
        encodeTlv(MERCHANT_TAG.billerId, input.targetId) +
        optionalTlv(MERCHANT_TAG.reference1, input.reference1) +
        optionalTlv(MERCHANT_TAG.reference2, input.reference2)
      : encodeTlv('00', AID.personal) + encodeTlv(PERSONAL_TARGET_TAGS[input.targetType], input.targetId);

  const body =
    encodeTlv(TAG.payloadFormat, PAYLOAD_FORMAT) +
    encodeTlv(TAG.initiation, input.amount ? INITIATION.dynamic : INITIATION.static) +
    encodeTlv(input.kind === 'merchant' ? TAG.merchant : TAG.personal, payee) +
    encodeTlv(TAG.currency, THB_NUMERIC) +
    (input.amount ? encodeTlv(TAG.amount, formatMinor(input.amount.minor, FIAT_DECIMALS.THB)) : '') +
    encodeTlv(TAG.country, COUNTRY_TH) +
    optionalTlv(TAG.merchantName, input.merchantName) +
    optionalTlv(TAG.merchantCity, input.merchantCity) +
    `${TAG.crc}04`;

  return body + crc16(body);
}

function optionalTlv(tag: string, value: string | undefined): string {
  return value === undefined ? '' : encodeTlv(tag, value);
}
