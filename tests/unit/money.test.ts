import { describe, expect, it } from 'vitest';
import { MAX_INPUT_CENTS, addCents, centsToInput, formatUsd, parseMoney, sumCents } from '../../src/domain/money';

const cents = (s: string) => {
  const r = parseMoney(s);
  if (!r.ok) throw new Error(`rejected ${s}: ${r.error}`);
  return r.cents;
};

describe('parseMoney', () => {
  it.each([
    ['35', 3500],
    ['35.5', 3550],
    ['35.50', 3550],
    ['$35.00', 3500],
    ['  0.10 ', 10],
    ['0', 0],
    ['1,234.56', 123456],
    ['$1,000,000', 100000000],
    ['0.5', 50],
  ])('accepts %s', (input, expected) => {
    expect(cents(input)).toBe(expected);
  });

  it.each([
    ['', 'empty'],
    ['   ', 'empty'],
    ['-5', 'negative'],
    ['−5', 'negative'],
    ['$-5', 'negative'],
    ['(5.00)', 'negative'],
    ['1.234', 'too_precise'],
    ['0.001', 'too_precise'],
    ['1e3', 'malformed'],
    ['abc', 'malformed'],
    ['12.', 'malformed'],
    ['.5', 'malformed'],
    ['1,23', 'malformed'],
    ['12,34.00', 'malformed'],
    ['1 000', 'malformed'],
    ['0x10', 'malformed'],
    ['+5', 'malformed'],
    ['Infinity', 'malformed'],
    ['NaN', 'malformed'],
    ['5 USD', 'malformed'],
    ['1000000000.01', 'too_large'],
    ['99999999999999999999', 'too_large'],
  ])('rejects %j as %s', (input, error) => {
    expect(parseMoney(input)).toEqual({ ok: false, error });
  });

  it('accepts exactly the maximum', () => {
    expect(cents('1000000000.00')).toBe(MAX_INPUT_CENTS);
  });
});

describe('integer cent arithmetic', () => {
  it('$0.10 + $0.20 equals $0.30 exactly (acceptance 8)', () => {
    const sum = addCents(cents('0.10'), cents('0.20'));
    expect(sum).toBe(cents('0.30'));
    expect(formatUsd(sum)).toBe('$0.30');
    // The floating-point dollar version would not be exact:
    expect(0.1 + 0.2 === 0.3).toBe(false);
  });

  it('refuses to produce unsafe integers', () => {
    expect(() => addCents(Number.MAX_SAFE_INTEGER, 1)).toThrow(RangeError);
    expect(() => addCents(0.5, 1)).toThrow(RangeError);
    expect(() => sumCents([Number.MAX_SAFE_INTEGER, 1])).toThrow(RangeError);
  });
});

describe('formatUsd', () => {
  it.each([
    [0, '$0.00'],
    [5, '$0.05'],
    [123456, '$1,234.56'],
    [-2000, '−$20.00'],
    [100000000000, '$1,000,000,000.00'],
  ])('%i -> %s', (input, expected) => {
    expect(formatUsd(input)).toBe(expected);
  });

  it('round-trips through the input format', () => {
    expect(cents(centsToInput(123456))).toBe(123456);
    expect(centsToInput(3500)).toBe('35.00');
  });
});
