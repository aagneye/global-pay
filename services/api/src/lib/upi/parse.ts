import type { UpiMerchant } from '../../domain/merchant.js';
import { FIAT_DECIMALS, parseDecimal } from '../../domain/money.js';
import { AppError } from '../../shared/errors.js';

/** A UPI ID (VPA): "name@handle". */
export const UPI_VPA = /^[A-Za-z0-9._-]{2,256}@[A-Za-z][A-Za-z0-9]{1,63}$/;

const UPI_PAY = /^upi:\/\/pay\?/i;

export class UpiParseError extends AppError {
  constructor(message: string, code = 'invalid_qr') {
    super(code, message, 422);
    this.name = 'UpiParseError';
  }
}

/** True if the payload is a UPI payment link (scheme and host in any case). */
export function isUpiQr(payload: string): boolean {
  return UPI_PAY.test(payload.trim());
}

/**
 * Parses a UPI QR: `upi://pay?pa=<vpa>&pn=<name>&am=<amount>&cu=INR&mc=<code>&tr=<ref>&tn=<note>`.
 * Parameters are URL-decoded. `pa` is required; `cu` must be INR or absent (422 `currency_not_supported`);
 * `am`, if present, is a rupee amount with at most 2 decimals and fixes the amount. Anything else wrong is
 * 422 `invalid_qr`.
 */
export function parseUpiQr(payload: string): UpiMerchant {
  const raw = payload.trim();
  if (!UPI_PAY.test(raw)) throw new UpiParseError('Not a UPI payment QR');

  const params = new Map<string, string>();
  try {
    for (const [key, value] of new URLSearchParams(raw.slice(raw.indexOf('?') + 1))) {
      const name = key.toLowerCase();
      if (!params.has(name)) params.set(name, value.trim());
    }
  } catch {
    throw new UpiParseError('UPI QR parameters are malformed');
  }
  const get = (name: string) => {
    const value = params.get(name);
    return value === undefined || value === '' ? undefined : value;
  };

  const vpa = get('pa');
  if (!vpa) throw new UpiParseError('UPI QR has no payee address (pa)');
  if (!UPI_VPA.test(vpa)) throw new UpiParseError('UPI QR payee address (pa) is not a valid UPI ID');

  const currency = get('cu');
  if (currency !== undefined && currency.toUpperCase() !== 'INR') {
    throw new UpiParseError('Only Indian rupee (INR) UPI QRs are supported', 'currency_not_supported');
  }

  const am = get('am');
  let amount: UpiMerchant['amount'];
  if (am !== undefined) {
    const minor = parseDecimal(am, FIAT_DECIMALS.INR);
    if (minor === null || minor <= 0n) throw new UpiParseError('UPI QR amount (am) must be a positive amount with at most 2 decimals');
    amount = { currency: 'INR', minor };
  }

  const name = get('pn');
  const merchantCode = get('mc');
  const reference = get('tr');
  const note = get('tn');
  return {
    kind: 'upi',
    raw,
    vpa,
    ...(name === undefined ? {} : { name }),
    ...(amount === undefined ? {} : { amount }),
    ...(merchantCode === undefined ? {} : { merchantCode }),
    ...(reference === undefined ? {} : { reference }),
    ...(note === undefined ? {} : { note }),
  };
}
