import { describe, expect, it } from 'vitest';
import { ceilDiv, formatMinor, parseDecimal } from '../src/domain/money.js';

describe('parseDecimal', () => {
  it('converts decimal strings to minor units', () => {
    expect(parseDecimal('100', 2)).toBe(10_000n);
    expect(parseDecimal('100.5', 2)).toBe(10_050n);
    expect(parseDecimal('0.01', 2)).toBe(1n);
    expect(parseDecimal('33.76732154', 8)).toBe(3_376_732_154n);
  });

  it('rejects anything that is not a plain non-negative decimal', () => {
    for (const value of ['', '.5', '1.', '-1', '1e3', ' 1', '1,000', '0x10', 'abc']) {
      expect(parseDecimal(value, 2), value).toBeNull();
    }
  });

  it('rejects extra fraction digits unless asked to truncate', () => {
    expect(parseDecimal('1.005', 2)).toBeNull();
    expect(parseDecimal('33.7673215487947879956', 8, { truncate: true })).toBe(3_376_732_154n);
  });
});

describe('formatMinor', () => {
  it('formats with exactly the given number of decimals', () => {
    expect(formatMinor(10_000n, 2)).toBe('100.00');
    expect(formatMinor(5n, 2)).toBe('0.05');
    expect(formatMinor(0n, 6)).toBe('0.000000');
    expect(formatMinor(1_500_000n, 6)).toBe('1.500000');
    expect(formatMinor(42n, 0)).toBe('42');
    expect(formatMinor(-150n, 2)).toBe('-1.50');
  });

  it('round-trips with parseDecimal', () => {
    for (const minor of [1n, 99n, 100n, 123_456_789n]) {
      expect(parseDecimal(formatMinor(minor, 2), 2)).toBe(minor);
    }
  });
});

describe('ceilDiv', () => {
  it('rounds up only when there is a remainder', () => {
    expect(ceilDiv(10n, 5n)).toBe(2n);
    expect(ceilDiv(11n, 5n)).toBe(3n);
    expect(ceilDiv(1n, 3n)).toBe(1n);
  });
});
