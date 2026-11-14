import { describe, expect, it } from 'vitest';
import {
  InvalidTransitionError,
  assertTransition,
  canTransition,
  isTerminal,
} from '../src/domain/payment.js';

describe('payment state machine', () => {
  it('allows the settle path', () => {
    expect(canTransition('SUBMITTED', 'PAID')).toBe(true);
    expect(canTransition('PAID', 'PAYOUT_PENDING')).toBe(true);
    expect(canTransition('PAYOUT_PENDING', 'SETTLED')).toBe(true);
  });

  it('allows the refund and failure paths', () => {
    expect(canTransition('PAYOUT_PENDING', 'REFUNDED')).toBe(true);
    expect(canTransition('SUBMITTED', 'FAILED')).toBe(true);
  });

  it('lets the chain correct a FAILED payment to PAID, and nothing else', () => {
    expect(canTransition('FAILED', 'PAID')).toBe(true);
    expect(canTransition('FAILED', 'SETTLED')).toBe(false);
    expect(canTransition('FAILED', 'SUBMITTED')).toBe(false);
  });

  it('rejects skipped or reversed steps', () => {
    expect(canTransition('SUBMITTED', 'SETTLED')).toBe(false);
    expect(canTransition('PAID', 'REFUNDED')).toBe(false);
    expect(() => assertTransition('SETTLED', 'REFUNDED')).toThrow(InvalidTransitionError);
  });

  it('treats SETTLED, REFUNDED and FAILED as terminal', () => {
    expect(isTerminal('SETTLED')).toBe(true);
    expect(isTerminal('REFUNDED')).toBe(true);
    expect(isTerminal('FAILED')).toBe(true);
    expect(isTerminal('PAYOUT_PENDING')).toBe(false);
  });
});
