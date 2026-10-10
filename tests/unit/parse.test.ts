// Parser contracts. Every excerpt here is SYNTHETIC: written for these tests,
// not copied from Amazon. They pin the documented patterns; they do not prove
// current Amazon wording.

import { describe, expect, it } from 'vitest';
import { EXCERPT_MAX_CHARS, PARSER_VERSION, analyzeExcerpt, normalizeExcerpt } from '../../src/capture/parse';
import { assessOrder, orderContextOf } from '../../src/capture/order';

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

describe('complete monetary tokens (finding 1)', () => {
  it.each([
    'Refund issued: $1e3',
    'Refund issued: $70 000.00',
    'Refund issued: $70/00',
    'Refund issued: $70.00.5',
    'Refund issued: $70,00',
    'Refund issued: $70.00USD',
    'Refund issued: $70k',
    'Refund issued: $70.00-$80.00',
    'Refund issued: $70.00 3',
    'Refund issued: $7O.00',
    'Refund issued: $70_00',
    'Refund issued: $70.0O',
    'Refund issued\n$1e3',
  ])('rejects the whole malformed token in %j', (text) => {
    const r = analyzeExcerpt(text);
    expect(r.issued).toBeNull();
    expect(r.problems).toContain('malformed_amount');
  });

  it.each([
    ['Refund issued: $70.00.', 7000, '$70.00'],
    ['Refund issued: $70.00, thank you', 7000, '$70.00'],
    ['Refund issued: $70; Visa ending in 1234', 7000, '$70'],
    ['Refund issued: $1,234.56 USD', 123456, '$1,234.56'],
    ['Refund issued ($70.00)', 7000, '$70.00'],
    ['Refund issued: US$70.00', 7000, 'US$70.00'],
    ['Refund issued: $ 70.00', 7000, '$ 70.00'],
    ['Refund issued\n$70.00 USD', 7000, '$70.00'],
    ['Refund issued\n$70.00.', 7000, '$70.00'],
    ['Refund issued: $70.00 on October 3, 2026', 7000, '$70.00'],
    ['Refunded $70.00 to Mastercard ending in 4321.', 7000, '$70.00'],
  ])('still accepts %j', (text, cents, amountText) => {
    const r = analyzeExcerpt(text);
    expect(r.problems).toEqual([]);
    expect(r.issued).toMatchObject({ cents, amountText });
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

describe('assessOrder (shared by popup and service worker)', () => {
  const ctx = (...ids: string[]) => orderContextOf(ids);
  const A = '112-1234567-7654321';
  const B = '113-7654321-1234567';

  it('compares only recognisable order IDs from the selection and the page URL', () => {
    expect(assessOrder(ctx(A), ctx(), `Order #${A}`)).toMatchObject({ ok: true, caseCheck: 'match' });
    expect(assessOrder(ctx(A), ctx(), B)).toMatchObject({ ok: false, block: 'case_mismatch' });
    expect(assessOrder(ctx(A), ctx(), null)).toMatchObject({ ok: true, caseCheck: 'case_has_no_order' });
    expect(assessOrder(ctx(A), ctx(), 'my kettle order')).toMatchObject({ ok: true, caseCheck: 'not_comparable' });
    expect(assessOrder(ctx(), ctx(), B)).toMatchObject({ ok: true, knownOrder: null, caseCheck: 'capture_has_no_order' });
  });

  it('uses the URL order when the selection has none (finding 2)', () => {
    expect(assessOrder(ctx(), ctx(A), B)).toMatchObject({ ok: false, block: 'case_mismatch', knownOrder: A });
    expect(assessOrder(ctx(), ctx(A), A)).toMatchObject({ ok: true, knownOrder: A, caseCheck: 'match' });
    expect(assessOrder(ctx(), ctx(A))).toMatchObject({ ok: true, knownOrder: A, caseCheck: 'no_case' });
  });

  it('blocks contradictions instead of choosing a side', () => {
    expect(assessOrder(ctx(B), ctx(A), A)).toMatchObject({ ok: false, block: 'source_excerpt_conflict' });
    expect(assessOrder(ctx(B), ctx(A), B)).toMatchObject({ ok: false, block: 'source_excerpt_conflict' });
    expect(assessOrder(ctx(B), ctx(A))).toMatchObject({ ok: false, block: 'source_excerpt_conflict' });
    expect(assessOrder(ctx(), ctx(A, B), A)).toMatchObject({ ok: false, block: 'source_ambiguous' });
    expect(assessOrder(ctx(A, B), ctx(), A)).toMatchObject({ ok: false, block: 'excerpt_ambiguous' });
    // Same ID in both, in any letter case, is agreement.
    expect(assessOrder(ctx('d01-1234567-7654321'), ctx('D01-1234567-7654321'), 'D01-1234567-7654321')).toMatchObject({ ok: true, caseCheck: 'match' });
  });
});
