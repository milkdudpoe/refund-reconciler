// Parser contracts. Every excerpt here is SYNTHETIC: written for these tests,
// not copied from Amazon. They pin the documented patterns; they do not prove
// current Amazon wording.

import { describe, expect, it } from 'vitest';
import { EXCERPT_MAX_CHARS, PARSER_VERSION, analyzeExcerpt, compareOrder, normalizeExcerpt } from '../../src/capture/parse';

const issued = (text: string) => analyzeExcerpt(text).issued;
const problems = (text: string) => analyzeExcerpt(text).problems;

describe('analyzeExcerpt: supported issued patterns', () => {
  it.each([
    ['Refund issued: $70.00', 7000],
    ['Refund issued $70.00', 7000],
    ['Refund issued for $70.00', 7000],
    ['Refunded: $1,234.56', 123456],
    ['Amount refunded: $70', 7000],
    ['$70.00 refunded to Visa ending in 1234', 7000],
    ['Your refund of $35.50 has been issued.', 3550],
    ['We’ve issued a refund of $70.00 for Blue kettle.', 7000],
    ['Refund issued\n$70.00', 7000],
    ['Refund issued\nOctober 3, 2026\n$70.00', 7000],
    ['Blue kettle\nReturn received\nRefund issued: $70.00', 7000],
  ])('supported pattern #%#', (text, cents) => {
    const r = analyzeExcerpt(text);
    expect(r.problems).toEqual([]);
    expect(r.issued?.cents).toBe(cents);
    expect(r.parserVersion).toBe(PARSER_VERSION);
  });

  it('keeps the literal approved amount text from the excerpt', () => {
    expect(issued('Refund issued: $1,234.56')?.amountText).toBe('$1,234.56');
  });

  it('reads an order ID and a date in the issued statement, but only when unambiguous', () => {
    const r = analyzeExcerpt('Order # 112-1234567-7654321\nRefund issued on Oct 3, 2026: $70.00');
    expect(r.orderRef).toEqual({ status: 'found', value: '112-1234567-7654321' });
    expect(r.date).toEqual({ status: 'found', value: '2026-10-03' });
    // "May" as a month is not mistaken for the word "may".
    expect(analyzeExcerpt('Refund issued May 4, 2026: $70.00').date).toEqual({ status: 'found', value: '2026-05-04' });
  });

  it('leaves the date unknown when absent, invalid, several, or outside the issued statement', () => {
    expect(analyzeExcerpt('Refund issued: $70.00').date).toEqual({ status: 'none' });
    expect(analyzeExcerpt('Refund issued February 30, 2026: $70.00').date.status).toBe('unknown');
    expect(analyzeExcerpt('Refund issued Oct 3, 2026 and Oct 4, 2026: $70.00').date.status).toBe('unknown');
    expect(analyzeExcerpt('Ordered October 1, 2026\nRefund issued: $70.00').date).toEqual({ status: 'unknown', reason: 'outside_statement' });
    expect(analyzeExcerpt('Refund issued 10/03/2026: $70.00').date).toEqual({ status: 'none' });
  });
});

describe('analyzeExcerpt: never turns other amounts into an issued amount (acceptance 3)', () => {
  it.each([
    ['purchase price', 'Item price: $80.00'],
    ['order total', 'Order total: $105.00'],
    ['expected refund', 'Expected refund: $70.00'],
    ['estimated refund', 'Estimated refund: $70.00 by Oct 9, 2026'],
    ['future tense', 'Your refund of $70.00 will be issued when we receive your item.'],
    ['pending', 'Refund pending: $70.00'],
    ['processing', 'Refund of $70.00 is processing'],
    ['initiated', 'Refund initiated: $70.00'],
    ['return received only', 'Return received: $70.00'],
    ['recharge', 'You were charged $20.00'],
    ['reversed refund', 'Refund issued: $70.00 was reversed'],
    ['restocking fee', 'Refund issued: $70.00 less restocking fee'],
    ['not issued', 'Refund not issued: $70.00'],
    ['payment method only', 'Visa ending in 1234'],
    ['bare number', 'Refund issued 70.00'],
  ])('%s', (_name, text) => {
    expect(issued(text)).toBeNull();
    expect(problems(text).length).toBeGreaterThan(0);
  });

  it('picks the one issued amount and lists the others as not issued', () => {
    const r = analyzeExcerpt('Item price: $80.00\nEstimated refund: $75.00\nRefund issued: $70.00');
    expect(r.issued?.cents).toBe(7000);
    expect(r.notIssued).toEqual([
      { amountText: '$80.00', reason: 'purchase_price' },
      { amountText: '$75.00', reason: 'expected' },
    ]);
  });

  it('never chooses the largest or first amount when several are issued', () => {
    const text = 'Blue kettle\nRefund issued: $35.00\nRed mug\nRefund issued: $70.00';
    expect(issued(text)).toBeNull();
    expect(problems(text)).toContain('multiple_issued_amounts');
    // Equal amounts for two items are still two statements, not one.
    expect(problems('Refund issued: $35.00\nRefund issued: $35.00')).toContain('multiple_issued_amounts');
  });

  it('treats two amounts in one issued statement as ambiguous', () => {
    expect(problems('Refund issued: $70.00 of $80.00')).toContain('conflicting_wording');
  });

  it('does not assign an aggregate order refund to an item', () => {
    for (const text of [
      'Refund total: $105.00',
      'Total refund issued: $105.00',
      'Refund issued for this order: $105.00',
      'Refund issued for 3 items: $105.00',
      'Refund summary\nRefund issued: $105.00',
    ]) {
      expect(issued(text)).toBeNull();
      expect(problems(text)).toContain('aggregate_order_total');
    }
  });

  it('rejects other currencies and unsafe amounts through the cent parser', () => {
    for (const text of ['Refund issued: €70.00', 'Refund issued: CA$70.00', 'Refund issued: £70.00', 'Refund issued: 70.00 EUR']) {
      expect(problems(text)).toContain('unsupported_currency');
      expect(issued(text)).toBeNull();
    }
    for (const text of ['Refund issued: $70.005', 'Refund issued: $7,0.00', 'Refund issued: -$70.00', 'Refund issued: $-70.00', 'Refund issued: $10,000,000,000.00']) {
      expect(problems(text)).toContain('malformed_amount');
      expect(issued(text)).toBeNull();
    }
    expect(problems('Refund issued: $0.00')).toContain('zero_amount');
  });

  it('keeps several order IDs ambiguous', () => {
    const r = analyzeExcerpt('Order 112-1234567-7654321\nOrder 113-1234567-7654321\nRefund issued: $70.00');
    expect(r.orderRef.status).toBe('ambiguous');
    expect(r.issued).toBeNull();
    expect(r.problems).toContain('multiple_order_refs');
  });

  it('reports empty and over-limit text without parsing a truncated excerpt', () => {
    expect(problems('   \n  ')).toEqual(['empty']);
    const long = `Refund issued: $70.00 ${'x'.repeat(EXCERPT_MAX_CHARS)}`;
    const r = analyzeExcerpt(long);
    expect(r.problems).toEqual(['too_long']);
    expect(r.issued).toBeNull();
    expect(r.excerpt).toBe('');
  });
});

describe('normalizeExcerpt', () => {
  it('normalises whitespace and strips invisible or bidi control characters', () => {
    expect(normalizeExcerpt('  Refund issued:\t$70.00 \r\n\r\n\r\nBlue​ kettle‮ ')).toBe('Refund issued: $70.00\n\nBlue kettle');
  });
  it('a zero-width character cannot hide disqualifying wording', () => {
    expect(issued('Refund pen​ding: $70.00')).toBeNull();
  });
});

describe('compareOrder', () => {
  it('compares only recognisable order IDs', () => {
    expect(compareOrder('112-1234567-7654321', 'Order #112-1234567-7654321')).toBe('match');
    expect(compareOrder('112-1234567-7654321', '113-1234567-7654321')).toBe('mismatch');
    expect(compareOrder('112-1234567-7654321', null)).toBe('case_has_no_order');
    expect(compareOrder('112-1234567-7654321', 'my kettle order')).toBe('not_comparable');
    expect(compareOrder(null, '113-1234567-7654321')).toBe('excerpt_has_no_order');
  });
});
