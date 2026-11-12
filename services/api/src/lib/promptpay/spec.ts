import type { PromptPayTargetType } from '../../domain/promptpay.js';

/** Top-level EMVCo tags used by Thai PromptPay QRs. */
export const TAG = {
  payloadFormat: '00',
  initiation: '01',
  /** Credit transfer to a person (mobile, national ID, e-wallet). */
  personal: '29',
  /** Bill payment to a registered biller (merchant). */
  merchant: '30',
  currency: '53',
  amount: '54',
  country: '58',
  merchantName: '59',
  merchantCity: '60',
  crc: '63',
} as const;

export const PAYLOAD_FORMAT = '01';
export const INITIATION = { static: '11', dynamic: '12' } as const;
export const THB_NUMERIC = '764';
export const COUNTRY_TH = 'TH';

/** Application IDs inside tag 29 / 30, sub-tag 00. */
export const AID = {
  personal: 'A000000677010111',
  merchant: 'A000000677010112',
} as const;

/** Sub-tags inside tag 29 that carry the payee ID. */
export const PERSONAL_TARGET_TAGS: Record<Exclude<PromptPayTargetType, 'biller'>, string> = {
  mobile: '01',
  nationalId: '02',
  eWallet: '03',
};

/** Sub-tags inside tag 30. */
export const MERCHANT_TAG = { billerId: '01', reference1: '02', reference2: '03' } as const;

/**
 * Payee ID formats, all digits:
 * mobile "0066" + 9 digits; national or tax ID 13; e-wallet 15; biller ID 15 (tax ID + 2-digit suffix).
 */
export const TARGET_ID_LENGTH: Record<PromptPayTargetType, number> = {
  mobile: 13,
  nationalId: 13,
  eWallet: 15,
  biller: 15,
};

export function isValidTargetId(type: PromptPayTargetType, id: string): boolean {
  return /^\d+$/.test(id) && id.length === TARGET_ID_LENGTH[type];
}
