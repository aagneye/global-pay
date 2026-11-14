import { FIAT_DECIMALS, formatMinor } from '../../domain/money.js';

export interface UpiQrInput {
  vpa: string;
  name?: string;
  /** INR paise; omit for a static QR. */
  amountMinor?: bigint;
  /** Merchant category code: makes it a merchant QR. */
  merchantCode?: string;
  reference?: string;
  note?: string;
}

/** Builds a UPI QR payload, `upi://pay?pa=…&pn=…&am=…&cu=INR&mc=…&tr=…&tn=…` (tests, demo QRs). */
export function buildUpiQr(input: UpiQrInput): string {
  const params: [string, string | undefined][] = [
    ['pa', input.vpa],
    ['pn', input.name],
    ['am', input.amountMinor === undefined ? undefined : formatMinor(input.amountMinor, FIAT_DECIMALS.INR)],
    ['cu', 'INR'],
    ['mc', input.merchantCode],
    ['tr', input.reference],
    ['tn', input.note],
  ];
  const query = params
    .filter((entry): entry is [string, string] => entry[1] !== undefined)
    .map(([key, value]) => `${key}=${encodeURIComponent(value)}`)
    .join('&');
  return `upi://pay?${query}`;
}
