/**
 * Generic EMVCo QR helpers: TLV fields and the CRC.
 * A payload is a list of fields, each `TT LL VALUE`: a 2-digit tag, a 2-digit length, then the value.
 */

export interface TlvField {
  tag: string;
  value: string;
}

const TWO_DIGITS = /^\d{2}$/;

/** Encodes one field. The value must be 1 to 99 characters long. */
export function encodeTlv(tag: string, value: string): string {
  const length = [...value].length;
  if (!TWO_DIGITS.test(tag)) throw new RangeError(`EMV tag must be two digits: ${tag}`);
  if (length < 1 || length > 99) throw new RangeError(`EMV tag ${tag} value must be 1-99 characters`);
  return `${tag}${String(length).padStart(2, '0')}${value}`;
}

/**
 * Splits a payload into fields. Returns null if it's malformed: a tag or length that
 * isn't two digits, a zero length, a value running past the end, or a repeated tag.
 */
export function parseTlv(data: string): TlvField[] | null {
  const chars = [...data];
  const fields: TlvField[] = [];
  const seen = new Set<string>();
  let i = 0;
  while (i < chars.length) {
    if (i + 4 > chars.length) return null;
    const tag = chars.slice(i, i + 2).join('');
    const lengthText = chars.slice(i + 2, i + 4).join('');
    if (!TWO_DIGITS.test(tag) || !TWO_DIGITS.test(lengthText)) return null;
    const length = Number(lengthText);
    if (length === 0 || i + 4 + length > chars.length || seen.has(tag)) return null;
    fields.push({ tag, value: chars.slice(i + 4, i + 4 + length).join('') });
    seen.add(tag);
    i += 4 + length;
  }
  return fields;
}

/**
 * CRC-16/CCITT-FALSE (poly 0x1021, init 0xFFFF) over the UTF-8 bytes of `data`,
 * as 4 uppercase hex digits. EMVCo computes it over the payload up to and including "6304".
 */
export function crc16(data: string): string {
  let crc = 0xffff;
  for (const byte of new TextEncoder().encode(data)) {
    crc ^= byte << 8;
    for (let bit = 0; bit < 8; bit++) {
      crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
    }
  }
  return crc.toString(16).toUpperCase().padStart(4, '0');
}
